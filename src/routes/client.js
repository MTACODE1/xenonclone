const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const {
  getOrganisationByTenantId, getIssuesForOrg, getIssueByCheckType, updateOrganisationMeta,
  updateOrganisationSupplierPatternLookback, updateOrganisationMultiAccountPatternLookback,
  updateOrganisationCheckConfig,
  getTransactionCountsForOrg, getBankReconciliationForOrg, updateStatementBalance,
  getExcludedBankAccountIds, setBankAccountExcluded,
  getExpenseAccountsForOrg, getAccountCheckConfigurationForOrg,
  setAccountCheckConfiguration, getIssueFindings, getIssueFindingSummary, setFindingReviewStates,
  setLineReviewState, getLineReviewStates, setFindingNote, getFindingNotes, getAllFindingKeysForIssue,
  addContactExclusion,
  createStatementImport, deleteStatementImport, getStatementImportByHash, getStatementImportsForOrg,
  getXeroBankItemsForOrg, getFiledAccountsForOrg, getFiledAccountsExtractionsForOrg,
  upsertFiledAccounts, getReportFindings, getSetting,
  getCompaniesHouseProfileForOrg, updateOrganisationCompanyNumber, upsertCompaniesHouseProfile,
  toggleStaffOrgAccess, getAllInsightData, saveInsightData, getInsightData,
  getInsightAccountMappings, setInsightAccountMapping, getInsightCategorySettings, setInsightCategorySetting,
  getInsightWidgetVisibility, setInsightWidgetVisibility,
  getInsightSettingsKv, setInsightSettingsKv,
  getInsightCorpTaxRateBands, addInsightCorpTaxRateBand, deleteInsightCorpTaxRateBand,
  getInsightCorpTaxAdjustments, setInsightCorpTaxAdjustment, deleteInsightCorpTaxAdjustment,
} = require('../db/queries');
const { syncOrganisation, CHECK_DEFINITIONS } = require('../services/xeroSync');
const { CASH_HEALTH_CATEGORIES } = require('../services/insightSync');
const { resolveCheckDisplayStatus } = require('../services/checkRules');
const { fetchCompanyProfile, normalizeCompanyNumber } = require('../services/companiesHouse');
const {
  periodInput, resolvePeriod, shouldUseCacheOnlyForReanalysis,
} = require('../services/periodResolver');
const { startJob } = require('../services/syncJobs');
const checkDescriptions = require('../data/checkDescriptions');
const {
  matchStatementLines, normalizeStatementLines, recomputeEvidenceIssues, sha256
} = require('../services/statementEvidence');
const puppeteer = require('puppeteer');
const { resolveOrgAccess } = require('../middleware/orgAccess');
const { isStaffManager } = require('../services/staffPermissions');

// Mounted with an explicit ':tenantId' path segment (not app.js's bare '/client' prefix) —
// Express only populates req.params from a path pattern that actually contains the named
// param, so this must live here rather than as plain middleware in app.js's app.use('/client', ...).
router.use('/:tenantId', resolveOrgAccess);

function parseScoreBreakdown(org) {
  try {
    const parsed = org.score_breakdown_json ? JSON.parse(org.score_breakdown_json) : null;
    return parsed && Array.isArray(parsed.observations) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function selectedPeriodFor(org, query = {}) {
  if (!query.period && org.period_type && org.period_start && org.period_end && org.period_key) {
    return Object.freeze({
      type: org.period_type,
      start: org.period_start,
      end: org.period_end,
      key: org.period_key,
      label: org.period_label || `${org.period_start} to ${org.period_end}`,
      monthsCovered: 1,
    });
  }
  const fallback = org.period_type || getSetting('default_sync_period') || 'since_lock_date';
  return resolvePeriod(periodInput(query, fallback), {
    lockDate: org.lock_date,
    financialYearEndDay: org.financial_year_end_day,
    financialYearEndMonth: org.financial_year_end_month,
  });
}

function clientViewData(org, query = {}) {
  const selectedPeriod = selectedPeriodFor(org, query);
  const periodQuery = new URLSearchParams({
    period: selectedPeriod.type,
    ...(selectedPeriod.type === 'custom' ? { from: selectedPeriod.start, to: selectedPeriod.end } : {}),
  }).toString();
  const issues = getIssuesForOrg(org.id);
  const checkDefs = CHECK_DEFINITIONS.map(def => {
    const issue = issues.find(i => i.check_type === def.type);
    const merged = { ...def, ...(issue || { count: null, potential_value_gbp: 0 }) };
    // Single source of truth for what this check's state means — the template must never re-derive
    // this from its own period_checked string comparisons (see checkRules.js/periodStatus.js).
    return { ...merged, displayStatus: resolveCheckDisplayStatus(merged) };
  });
  return {
    org, issues, checkDefs, selectedPeriod, periodQuery,
    isStale: !org.last_successful_sync_at ||
      Date.now() - new Date(org.last_successful_sync_at).getTime() > 36 * 60 * 60 * 1000,
    txCounts: getTransactionCountsForOrg(org.id, selectedPeriod.type, selectedPeriod.start, selectedPeriod.end),
    bankReconciliation: getBankReconciliationForOrg(org.id),
    excludedBankAccountIds: getExcludedBankAccountIds(org.id),
    statementImports: getStatementImportsForOrg(org.id),
    filedAccounts: getFiledAccountsForOrg(org.id),
    filedAccountsExtractions: getFiledAccountsExtractionsForOrg(org.id),
    companiesHouse: getCompaniesHouseProfileForOrg(org.id),
    companiesHouseKeySet: !!getSetting('companies_house_api_key'),
    expenseAccounts: getExpenseAccountsForOrg(org.id),
    accountConfigurations: getAccountCheckConfigurationForOrg(org.id),
    scoreBreakdown: parseScoreBreakdown(org),
    insight: getAllInsightData(org.id),
    insightKv: getInsightSettingsKv(org.id),
    insightMappings: getInsightAccountMappings(org.id),
    insightWidgetVisibility: getInsightWidgetVisibility(org.id),
    checkDescriptions,
  };
}

const evidenceDir = path.join(__dirname, '../../data/evidence');
fs.mkdirSync(evidenceDir, { recursive: true });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 },
  fileFilter: (req, file, callback) => {
    const isCsv = file.mimetype === 'text/csv' || file.mimetype === 'application/vnd.ms-excel' ||
      path.extname(file.originalname).toLowerCase() === '.csv';
    callback(isCsv ? null : new Error('Only CSV statement files are accepted'), isCsv);
  },
});
const sourceDocumentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (req, file, callback) => {
    const allowed = new Set(['application/pdf', 'text/csv', 'image/png', 'image/jpeg']);
    callback(allowed.has(file.mimetype) ? null : new Error('Source document must be PDF, CSV, PNG or JPEG'), allowed.has(file.mimetype));
  },
});
const acceptStatementUpload = (req, res, next) =>
  upload.single('statement_csv')(req, res, error =>
    error ? res.status(400).send(error.message) : next()
  );
const acceptSourceDocument = (req, res, next) =>
  sourceDocumentUpload.single('source_document')(req, res, error =>
    error ? res.status(400).send(error.message) : next()
  );

function xeroLinks(checkType, item) {
  const links = [];
  const add = (label, url) => { if (url && !links.some(link => link.url === url)) links.push({ label, url }); };
  const bankSource = /^bank/.test(item.source || '');
  const invoiceId = (!bankSource && (item.invoiceId || item.invoiceID)) ||
    (/(invoice|bill|undocumented)/.test(checkType) ? item.id : null);
  if (invoiceId) {
    const payable = /(bill|purchase|supplier|sales_tax_on_bills)/.test(checkType);
    add(payable ? 'Open bill' : 'Open invoice',
      `https://go.xero.com/${payable ? 'AccountsPayable' : 'AccountsReceivable'}/View.aspx?InvoiceID=${encodeURIComponent(invoiceId)}`);
  }
  if (/duplicate_(invoices|bills)/.test(checkType)) {
    const payable = checkType === 'duplicate_bills';
    for (const id of [item.id1, item.id2].filter(Boolean)) {
      add(payable ? 'Open bill' : 'Open invoice',
        `https://go.xero.com/${payable ? 'AccountsPayable' : 'AccountsReceivable'}/View.aspx?InvoiceID=${encodeURIComponent(id)}`);
    }
  }
  const bankId = item.bankTransactionId || item.bankTransactionID ||
    (bankSource ? (item.invoiceId || item.id) : null);
  if (bankId) add('Open bank transaction',
    `https://go.xero.com/Bank/ViewTransaction.aspx?bankTransactionID=${encodeURIComponent(bankId)}`);
  const paymentId = item.paymentId || item.paymentID || (item.source === 'payment' ? item.id : null);
  if (paymentId) add('Find payment',
    `https://go.xero.com/Search/Default.aspx?searchTerm=${encodeURIComponent(paymentId)}`);
  const creditId = item.creditNoteId || item.creditNoteID ||
    (/credits/.test(checkType) ? item.id : null);
  if (creditId) {
    const payable = /purchase/.test(checkType);
    add('Open credit note',
      `https://go.xero.com/${payable ? 'AccountsPayable' : 'AccountsReceivable'}/ViewCreditNote.aspx?creditNoteID=${encodeURIComponent(creditId)}`);
  }
  const contactIds = [item.contactId, item.contactID];
  if (/duplicate_contacts/.test(checkType)) contactIds.push(item.id1, item.id2);
  for (const contactId of contactIds.filter(Boolean)) {
    add('Open contact', `https://go.xero.com/Contacts/View/${encodeURIComponent(contactId)}`);
  }
  if (!links.length) {
    const term = item.number || item.invoiceNumber || item.contact || item.name || item.finding_key;
    add('Search in Xero', `https://go.xero.com/Search/Default.aspx?searchTerm=${encodeURIComponent(term)}`);
  }
  return links;
}

function verifyCsrf(req, res, next) {
  const supplied = req.body?.csrf_token || req.get('x-csrf-token');
  if (!req.session.csrfToken || supplied !== req.session.csrfToken) {
    return res.status(403).send('Invalid form token');
  }
  next();
}

router.get('/:tenantId', (req, res) => {
  const { tenantId } = req.params;
  const org = getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  try {
    res.render('client', clientViewData(org, req.query));
  } catch (error) {
    res.status(400).send(error.message);
  }
});

router.get('/:tenantId/score-breakdown', (req, res) => {
  const org = getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).json({ error: 'Organisation not found' });
  const breakdown = parseScoreBreakdown(org);
  if (!breakdown) return res.status(404).json({ error: 'No scored sync is available' });
  res.json(breakdown);
});

router.post('/:tenantId/account-check-configuration', express.urlencoded({ extended: true }), verifyCsrf, (req, res) => {
  const { tenantId } = req.params;
  const org = getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const accounts = getAccountCheckConfigurationForOrg(org.id);
  const checked = name => new Set([req.body[name]].flat().filter(Boolean));
  const capital = checked('capital_accounts');
  const misallocated = checked('misallocated_accounts');
  const taxIgnored = checked('purchase_tax_ignored_accounts');
  const taxIncluded = checked('purchase_tax_asset_prepayment_accounts');
  const positiveNumber = value => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  const configurations = accounts.map(account => ({
    account_code: account.account_code,
    is_capital_candidate: capital.has(account.account_code),
    capital_review_threshold: positiveNumber(req.body.capital_threshold?.[account.account_code]),
    monitor_misallocated: misallocated.has(account.account_code),
    misallocated_threshold: positiveNumber(req.body.misallocated_threshold?.[account.account_code]),
    purchase_tax_ignore: taxIgnored.has(account.account_code),
    purchase_tax_include_asset_prepayment: taxIncluded.has(account.account_code),
  }));
  setAccountCheckConfiguration(org.id, configurations);
  res.redirect(`/client/${tenantId}#capital-review-accounts`);
});

router.post('/:tenantId/supplier-pattern-lookback', express.urlencoded({ extended: true }), (req, res) => {
  const { tenantId } = req.params;
  const org = getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  if (!req.session.csrfToken || req.body.csrf_token !== req.session.csrfToken) {
    return res.status(403).send('Invalid form token');
  }
  const months = parseInt(req.body.supplier_pattern_lookback_months, 10);
  updateOrganisationSupplierPatternLookback(org.id, Number.isFinite(months) ? months : null);
  const multiAccountMonths = parseInt(req.body.multi_account_pattern_lookback_months, 10);
  updateOrganisationMultiAccountPatternLookback(org.id, Number.isFinite(multiAccountMonths) ? multiAccountMonths : null);
  res.redirect(`/client/${tenantId}#supplier-pattern-lookback`);
});

router.post('/:tenantId/check-config', express.urlencoded({ extended: true }), (req, res) => {
  const { tenantId } = req.params;
  const org = getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  if (!req.session.csrfToken || req.body.csrf_token !== req.session.csrfToken) {
    return res.status(403).send('Invalid form token');
  }
  // A blank form field means "clear this override, fall back to the practice default" — an empty
  // string must become a real null before it reaches the query layer, since Number('') is 0 (a
  // real, wrong value), not "unset". The resolver layer (resolvePurchaseTaxMissingExcludeCodes)
  // does support a deliberate empty-string override ("no exclusions") distinct from null ("not
  // configured"), but this form has no way to express that distinction cleanly, so a blank field
  // here means "no override" like every other field — the rarer case stays reachable directly in
  // the database if ever needed, just not from this form.
  const blankToNull = value => (value === '' || value == null ? null : value);
  updateOrganisationCheckConfig(org.id, {
    opening_balance_threshold_gbp: blankToNull(req.body.opening_balance_threshold_gbp),
    capital_review_default_threshold_gbp: blankToNull(req.body.capital_review_default_threshold_gbp),
    misallocated_items_default_threshold_gbp: blankToNull(req.body.misallocated_items_default_threshold_gbp),
    multi_account_suppliers_min_value_gbp: blankToNull(req.body.multi_account_suppliers_min_value_gbp),
    multi_tax_suppliers_min_value_gbp: blankToNull(req.body.multi_tax_suppliers_min_value_gbp),
    purchase_tax_missing_exclude_codes: blankToNull(req.body.purchase_tax_missing_exclude_codes),
    duplicate_invoice_window_days: blankToNull(req.body.duplicate_invoice_window_days),
    duplicate_bill_window_days: blankToNull(req.body.duplicate_bill_window_days),
    // Tri-state selects ('', '1', '0') — updateOrganisationCheckConfig's triStateBoolOrNull handles
    // the '' -> null (not configured) mapping itself, so the raw value passes through unchanged.
    duplicate_invoice_require_exact_reference: req.body.duplicate_invoice_require_exact_reference,
    duplicate_invoice_include_fully_paid: req.body.duplicate_invoice_include_fully_paid,
    duplicate_bill_require_exact_reference: req.body.duplicate_bill_require_exact_reference,
    duplicate_bill_include_fully_paid: req.body.duplicate_bill_include_fully_paid,
    duplicate_invoice_require_exact_total: req.body.duplicate_invoice_require_exact_total,
    duplicate_bill_require_exact_total: req.body.duplicate_bill_require_exact_total,
  });
  res.redirect(`/client/${tenantId}#check-config`);
});

router.post('/:tenantId/bank-reconciliation', express.urlencoded({ extended: true }), verifyCsrf, (req, res) => {
  const { tenantId } = req.params;
  const { bank_account_id, statement_balance } = req.body;
  const org = getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const parsed = parseFloat(statement_balance);
  updateStatementBalance(org.id, bank_account_id, isNaN(parsed) ? null : parsed);
  recomputeEvidenceIssues(org.id);
  res.redirect(`/client/${tenantId}#bank-reconciliation`);
});

router.post('/:tenantId/bank-account-exclusion', express.urlencoded({ extended: true }), verifyCsrf, (req, res) => {
  const { tenantId } = req.params;
  const { bank_account_id, excluded } = req.body;
  const org = getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  if (!bank_account_id) return res.status(400).send('bank_account_id is required');
  // Xenon supports excluding individual bank accounts from Bank Balance and Unreconciled Bank
  // Items — organisation-scoped, so this can never affect another client's account, even one that
  // happens to share the same Xero bank_account_id (accounts are keyed by (org_id, account_id)).
  setBankAccountExcluded(org.id, bank_account_id, excluded === '1' || excluded === 'true');
  recomputeEvidenceIssues(org.id);
  res.redirect(`/client/${tenantId}#bank-reconciliation`);
});

router.post('/:tenantId/statement-import', acceptStatementUpload, (req, res) => {
  const { tenantId } = req.params;
  const org = getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  if (!req.file) return res.status(400).send('Select a CSV statement file');
  if (!req.session.csrfToken || req.body.csrf_token !== req.session.csrfToken) {
    return res.status(403).send('Invalid form token');
  }
  const accounts = getBankReconciliationForOrg(org.id);
  const account = accounts.find(item => item.bank_account_id === req.body.bank_account_id);
  if (!account) return res.status(400).send('Select a bank account synced from Xero');
  const hash = sha256(req.file.buffer);
  if (getStatementImportByHash(org.id, hash)) return res.status(409).send('This statement file has already been imported');
  try {
    const parsed = normalizeStatementLines(req.file.buffer.toString('utf8'), {
      date: req.body.date_column, amount: req.body.amount_column,
      debit: req.body.debit_column, credit: req.body.credit_column,
      reference: req.body.reference_column, description: req.body.description_column,
    });
    const startDate = req.body.statement_start_date;
    const endDate = req.body.statement_end_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
      return res.status(400).send('Enter a valid statement start and end date');
    }
    if (parsed.lines.some(line => line.transactionDate < startDate || line.transactionDate > endDate)) {
      return res.status(400).send('Every CSV transaction date must fall within the statement date range');
    }
    const closingBalance = Number(req.body.closing_balance);
    const openingBalance = req.body.opening_balance === '' ? null : Number(req.body.opening_balance);
    if (!Number.isFinite(closingBalance) || (openingBalance != null && !Number.isFinite(openingBalance))) {
      return res.status(400).send('Enter valid opening and closing balances');
    }
    const matched = matchStatementLines(parsed.lines, getXeroBankItemsForOrg(org.id), account.bank_account_id);
    const storedFilename = `${crypto.randomUUID()}.csv`;
    fs.writeFileSync(path.join(evidenceDir, storedFilename), req.file.buffer, { flag: 'wx', mode: 0o600 });
    try {
      createStatementImport(org.id, {
        bankAccountId: account.bank_account_id, bankAccountName: account.bank_account_name,
        originalFilename: path.basename(req.file.originalname), storedFilename, fileSha256: hash,
        statementStartDate: startDate, statementEndDate: endDate, openingBalance, closingBalance,
        columnMapping: parsed.mapping,
      }, matched);
    } catch (error) {
      fs.rmSync(path.join(evidenceDir, storedFilename), { force: true });
      throw error;
    }
    recomputeEvidenceIssues(org.id);
    res.redirect(`/client/${encodeURIComponent(tenantId)}#statement-evidence`);
  } catch (error) {
    res.status(400).send(error.message);
  }
});

router.post('/:tenantId/statement-import/:importId/delete', express.urlencoded({ extended: true }), verifyCsrf, (req, res) => {
  const org = getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const removed = deleteStatementImport(org.id, Number(req.params.importId));
  if (!removed) return res.status(404).send('Statement import not found');
  const safeName = path.basename(removed.stored_filename);
  if (safeName === removed.stored_filename) fs.rmSync(path.join(evidenceDir, safeName), { force: true });
  recomputeEvidenceIssues(org.id);
  res.redirect(`/client/${encodeURIComponent(req.params.tenantId)}#statement-evidence`);
});

router.post('/:tenantId/filed-accounts', acceptSourceDocument, (req, res) => {
  const org = getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  if (!req.session.csrfToken || req.body.csrf_token !== req.session.csrfToken) {
    return res.status(403).send('Invalid form token');
  }
  const filingDate = req.body.filing_date;
  const netAssets = Number(req.body.net_assets);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(filingDate) || !Number.isFinite(netAssets)) {
    return res.status(400).send('Enter a valid filing date and net assets');
  }
  let storedFilename = null;
  if (req.file) {
    const extension = { 'application/pdf': '.pdf', 'text/csv': '.csv', 'image/png': '.png', 'image/jpeg': '.jpg' }[req.file.mimetype];
    storedFilename = `${crypto.randomUUID()}${extension}`;
    fs.writeFileSync(path.join(evidenceDir, storedFilename), req.file.buffer, { flag: 'wx', mode: 0o600 });
  }
  upsertFiledAccounts(org.id, {
    filingDate, netAssets, sourceNote: String(req.body.source_note || '').slice(0, 1000),
    sourceDocumentPath: storedFilename,
  });
  recomputeEvidenceIssues(org.id);
  res.redirect(`/client/${encodeURIComponent(req.params.tenantId)}#filed-accounts`);
});

router.post('/:tenantId/companies-house', express.urlencoded({ extended: true }), verifyCsrf, async (req, res) => {
  const org = getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const number = normalizeCompanyNumber(req.body.company_number);
  if (!number) return res.status(400).send('Enter a valid company number');
  updateOrganisationCompanyNumber(org.id, number);
  const apiKey = getSetting('companies_house_api_key');
  try {
    const { profile, raw } = await fetchCompanyProfile(number, apiKey);
    upsertCompaniesHouseProfile(org.id, { ...profile, rawJson: JSON.stringify(raw), fetchError: null });
  } catch (error) {
    upsertCompaniesHouseProfile(org.id, {
      companyNumber: number, sicCodes: [], rawJson: null, fetchError: error.message,
    });
  }
  res.redirect(`/client/${encodeURIComponent(req.params.tenantId)}#companies-house`);
});

router.get('/:tenantId/check/:checkType', (req, res) => {
  const { tenantId, checkType } = req.params;
  const org = getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const issue = getIssueByCheckType(org.id, checkType);
  const def = CHECK_DEFINITIONS.find(d => d.type === checkType);
  let pagination = { items: [], page: 1, pageSize: 50, total: 0, totalPages: 1 };
  let summary = { active: 0, dismissed: 0, ignored: 0, ok: 0 };
  const status = ['active', 'dismissed', 'ignored', 'ok', 'all'].includes(req.query.status)
    ? req.query.status : 'all';
  if (issue) {
    pagination = getIssueFindings(issue.id, org.id, req.query.page, 50, status);
    summary = getIssueFindingSummary(issue.id, org.id);
    if (pagination.total === 0 && issue.detail_json) {
      try {
        pagination.items = JSON.parse(issue.detail_json);
        pagination.total = pagination.items.length;
      } catch (error) {
        pagination.items = [];
      }
    }
  }
  // Attached at display time, not stored on the finding — this way every check whose findings
  // already carry a raw accountCode (misallocated_items, purchase_tax_missing, sales_tax_missing,
  // unexpected_account_used, etc. — most of the 29) picks up the friendly account name for its
  // colored badge immediately, for findings already synced, with no re-sync required anywhere.
  const accountNameByCode = {};
  for (const account of getAccountCheckConfigurationForOrg(org.id)) {
    if (account.account_code) accountNameByCode[account.account_code] = account.account_name;
  }
  // A note attached to a finding independent of its dismiss/ignore/ok state (Xenon's "Add Note" is
  // its own action, not tied to those three) — see setFindingNote's comment.
  const findingNotes = getFindingNotes(org.id, checkType);
  // multi_account_suppliers/multi_tax_suppliers findings carry the underlying transactions behind
  // the aggregate contact-level total (added for the drill-down view) — each one needs its own
  // "Open in Xero" link, same mechanism as the top-level finding, just computed per transaction,
  // plus its own reviewed/note state (finding_line_reviews — a separate, lighter-weight audit trail
  // from the contact-level dismiss/ignore/OK above; see setLineReviewState's comment).
  // "Age" (days since document date) only makes sense for the old_* family (old_unpaid_invoices,
  // old_sales_credits, old_unpaid_bills, old_purchase_credits) — matches what Xenon itself shows
  // this column for. Computed at render time against the real current date, same as a user reading
  // "how old is this right now" would expect, not the sync's own as-of date used to DECIDE it's old.
  const showAge = checkType.startsWith('old_');
  const items = pagination.items.map(item => {
    const lineReviews = Array.isArray(item.transactions) && item.transactions.length
      ? getLineReviewStates(org.id, checkType, item.finding_key)
      : {};
    return {
      ...item,
      xero_links: xeroLinks(checkType, item),
      standaloneNote: findingNotes[item.finding_key] || null,
      ageDays: (showAge && item.date) ? Math.floor((Date.now() - new Date(item.date).getTime()) / 86400000) : undefined,
      accountName: item.accountCode ? (item.accountName || accountNameByCode[item.accountCode] || null) : item.accountName,
      transactions: Array.isArray(item.transactions)
        ? item.transactions.map(tx => {
            const lineKey = tx.bankTransactionId || tx.invoiceId || null;
            return {
              ...tx,
              accountName: tx.accountCode ? (tx.accountName || accountNameByCode[tx.accountCode] || null) : tx.accountName,
              xero_links: xeroLinks(checkType, tx), lineKey, ...(lineKey ? lineReviews[lineKey] : {}),
            };
          })
        : undefined,
    };
  });
  const extraData = {};
  if (checkType === 'bank_balance') {
    extraData.bankReconciliation = getBankReconciliationForOrg(org.id);
    extraData.excludedBankAccountIds = getExcludedBankAccountIds(org.id);
  }
  res.render('checkDetail', { org, issue, def, items, pagination, summary, status, checkType, checkDescriptions, ...extraData });
});

router.post(
  '/:tenantId/check/:checkType/review',
  express.urlencoded({ extended: true }),
  verifyCsrf,
  (req, res) => {
    const { tenantId, checkType } = req.params;
    const org = getOrganisationByTenantId(tenantId);
    if (!org) return res.status(404).send('Organisation not found');
    // "Ignore/Dismiss all N items" applies to every finding matching the current status filter,
    // not just the ones visible on this page — matches Xenon's own bulk buttons, which state the
    // full count regardless of pagination.
    let findingKeys;
    if (req.body.select_all === '1') {
      const issue = getIssueByCheckType(org.id, checkType);
      const bulkStatus = ['active', 'dismissed', 'ignored', 'ok', 'all'].includes(req.body.return_status)
        ? req.body.return_status : 'active';
      findingKeys = issue ? getAllFindingKeysForIssue(issue.id, org.id, bulkStatus) : [];
    } else {
      findingKeys = [req.body.finding_key || req.body.finding_keys].flat().filter(Boolean);
    }
    try {
      setFindingReviewStates(org.id, checkType, findingKeys, req.body.action, req.body.notes);
    } catch (error) {
      return res.status(400).send(error.message);
    }
    const status = encodeURIComponent(req.body.return_status || 'active');
    const page = Math.max(1, Number(req.body.return_page) || 1);
    res.redirect(`/client/${encodeURIComponent(tenantId)}/check/${encodeURIComponent(checkType)}?status=${status}&page=${page}`);
  }
);

// Marks one underlying transaction (within a multi_account_suppliers/multi_tax_suppliers contact
// finding) reviewed — a lightweight audit trail only; never touches the parent finding's
// count/value/score, since those are computed per contact, not per transaction (see
// finding_line_reviews in schema.js).
router.post(
  '/:tenantId/check/:checkType/line-review',
  express.urlencoded({ extended: true }),
  verifyCsrf,
  (req, res) => {
    const { tenantId, checkType } = req.params;
    const org = getOrganisationByTenantId(tenantId);
    if (!org) return res.status(404).send('Organisation not found');
    try {
      setLineReviewState(org.id, checkType, req.body.finding_key, req.body.line_key, req.body.ok === '1', req.body.notes);
    } catch (error) {
      return res.status(400).send(error.message);
    }
    const status = encodeURIComponent(req.body.return_status || 'active');
    const page = Math.max(1, Number(req.body.return_page) || 1);
    res.redirect(`/client/${encodeURIComponent(tenantId)}/check/${encodeURIComponent(checkType)}?status=${status}&page=${page}`);
  }
);

// Attaches a note to a finding without changing its dismiss/ignore/ok state — see setFindingNote's
// comment for why this is deliberately a separate table/action from the review-state form above.
router.post(
  '/:tenantId/check/:checkType/note',
  express.urlencoded({ extended: true }),
  verifyCsrf,
  (req, res) => {
    const { tenantId, checkType } = req.params;
    const org = getOrganisationByTenantId(tenantId);
    if (!org) return res.status(404).send('Organisation not found');
    try {
      setFindingNote(org.id, checkType, req.body.finding_key, req.body.notes);
    } catch (error) {
      return res.status(400).send(error.message);
    }
    const status = encodeURIComponent(req.body.return_status || 'active');
    const page = Math.max(1, Number(req.body.return_page) || 1);
    res.redirect(`/client/${encodeURIComponent(tenantId)}/check/${encodeURIComponent(checkType)}?status=${status}&page=${page}`);
  }
);

// "Ignore this contact" — a PERMANENT exclusion (contact_exclusions) applied on the NEXT
// sync/reanalyse of this check, not immediately; see addContactExclusion's comment for why.
router.post(
  '/:tenantId/check/:checkType/ignore-contact',
  express.urlencoded({ extended: true }),
  verifyCsrf,
  (req, res) => {
    const { tenantId, checkType } = req.params;
    const org = getOrganisationByTenantId(tenantId);
    if (!org) return res.status(404).send('Organisation not found');
    try {
      addContactExclusion(org.id, checkType, req.body.contact_name);
    } catch (error) {
      return res.status(400).send(error.message);
    }
    const status = encodeURIComponent(req.body.return_status || 'active');
    const page = Math.max(1, Number(req.body.return_page) || 1);
    res.redirect(`/client/${encodeURIComponent(tenantId)}/check/${encodeURIComponent(checkType)}?status=${status}&page=${page}`);
  }
);

router.post('/:tenantId/insight/target', express.urlencoded({ extended: true }), verifyCsrf, (req, res) => {
  const org = getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const val = parseFloat(req.body.monthly_target);
  if (Number.isFinite(val) && val >= 0) saveInsightData(org.id, 'target', { basis: 'fixed', monthly_target: val });
  res.redirect(`/client/${encodeURIComponent(req.params.tenantId)}?panel=insight`);
});

router.post('/:tenantId/insight/ctax-override', express.urlencoded({ extended: true }), verifyCsrf, (req, res) => {
  const org = getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const idx = parseInt(req.body.fy_index, 10);
  const val = parseFloat(req.body.estimate);
  if (Number.isFinite(idx) && idx >= 0 && Number.isFinite(val) && val >= 0) {
    const existing = (() => {
      const row = getInsightData(org.id, 'corp_tax_overrides');
      return (row && row.data) ? row.data : {};
    })();
    existing[`fy${idx}`] = val;
    saveInsightData(org.id, 'corp_tax_overrides', existing);
  }
  res.redirect(`/client/${encodeURIComponent(req.params.tenantId)}?panel=insight`);
});

const INSIGHT_MAPPING_CATEGORIES = [
  { key: 'directors_loan', section: 'directors_loan' },
  { key: 'dividend', section: 'dividend' },
  { key: 'wc_trade_debtors', section: 'working_capital' },
  { key: 'wc_trade_creditors', section: 'working_capital' },
  { key: 'wc_stock', section: 'working_capital' },
  { key: 'cash_disregard_banks', section: 'cash_health' },
  { key: 'valuation_disregard', section: 'business_valuation' },
  ...CASH_HEALTH_CATEGORIES.map(c => ({ key: c.key, section: 'cash_health', label: c.label })),
];

const INSIGHT_WIDGET_KEYS = [
  'sales_tracker', 'cash_health', 'bookkeeping_health', 'profitability', 'corp_tax_estimate',
  'directors_loan', 'business_valuation', 'working_capital', 'dividend_availability',
];

const TARGET_BASIS_VALUES = ['none', 'fixed', 'previous_month', 'avg3', 'avg6', 'avg12', 'same_month_last_year'];
const VALUATION_MODEL_VALUES = ['', 'current_profit', 'current_sales', 'net_asset_value'];

router.get('/:tenantId/insight/settings', (req, res) => {
  const org = getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const targetRow = getInsightData(org.id, 'target');
  const kv = getInsightSettingsKv(org.id);
  const accounts = getAccountCheckConfigurationForOrg(org.id);
  const codeToName = {};
  for (const acc of accounts) codeToName[acc.account_code] = acc.account_name;
  res.render('insightSettings', {
    org,
    query: req.query,
    accounts,
    codeToName,
    mappings: getInsightAccountMappings(org.id),
    categorySettings: getInsightCategorySettings(org.id),
    widgetVisibility: getInsightWidgetVisibility(org.id),
    widgetKeys: INSIGHT_WIDGET_KEYS,
    target: (targetRow && targetRow.data) ? targetRow.data : {},
    cashHealthCategories: CASH_HEALTH_CATEGORIES,
    kv,
    rateBands: getInsightCorpTaxRateBands(org.id),
    addbacks: getInsightCorpTaxAdjustments(org.id, 'addback'),
    deductions: getInsightCorpTaxAdjustments(org.id, 'deduct_other'),
    capitalAllowances: getInsightCorpTaxAdjustments(org.id, 'capital_allowance'),
    csrfToken: res.locals.csrfToken,
  });
});

router.post('/:tenantId/insight/settings', express.urlencoded({ extended: true }), verifyCsrf, (req, res) => {
  const org = getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).send('Organisation not found');

  for (const cat of INSIGHT_MAPPING_CATEGORIES) {
    const raw = req.body[`accounts_${cat.key}`];
    const codes = raw == null ? [] : (Array.isArray(raw) ? raw : [raw]);
    setInsightAccountMapping(org.id, cat.key, codes);
  }

  for (const cat of CASH_HEALTH_CATEGORIES) {
    const enabled = req.body[`enabled_${cat.key}`] === 'on';
    const overrideEnabled = req.body[`override_enabled_${cat.key}`] === 'on';
    const overrideRaw = req.body[`override_value_${cat.key}`];
    const overrideValue = overrideRaw !== '' && overrideRaw != null && Number.isFinite(parseFloat(overrideRaw))
      ? parseFloat(overrideRaw) : null;
    setInsightCategorySetting(org.id, cat.key, { enabled, overrideEnabled, overrideValue });
  }

  for (const key of INSIGHT_WIDGET_KEYS) {
    setInsightWidgetVisibility(org.id, key, req.body[`widget_${key}`] === 'on', req.body[`widget_pdf_${key}`] === 'on');
  }

  const targetBasis = TARGET_BASIS_VALUES.includes(req.body.target_basis) ? req.body.target_basis : 'none';
  const fixedAmountRaw = req.body.target_fixed_amount;
  const fixedAmount = fixedAmountRaw !== '' && Number.isFinite(parseFloat(fixedAmountRaw)) ? parseFloat(fixedAmountRaw) : null;
  const pctIncreaseRaw = req.body.target_pct_increase;
  const pctIncrease = pctIncreaseRaw !== '' && Number.isFinite(parseFloat(pctIncreaseRaw)) ? parseFloat(pctIncreaseRaw) : 0;
  saveInsightData(org.id, 'target', {
    basis: targetBasis,
    monthly_target: targetBasis === 'fixed' ? fixedAmount : null,
    pct_increase: pctIncrease,
  });

  const valuationModel = VALUATION_MODEL_VALUES.includes(req.body.valuation_model) ? req.body.valuation_model : '';
  setInsightSettingsKv(org.id, 'valuation_model', valuationModel);
  const multipleRaw = req.body.valuation_multiple;
  setInsightSettingsKv(org.id, 'valuation_multiple', (multipleRaw !== '' && Number.isFinite(parseFloat(multipleRaw))) ? parseFloat(multipleRaw) : 1);

  // Corp tax rate bands: existing rows can be deleted (checkbox), plus one optional new row.
  const deleteIds = new Set((Array.isArray(req.body.delete_rate_band) ? req.body.delete_rate_band : [req.body.delete_rate_band]).filter(Boolean).map(Number));
  for (const id of deleteIds) deleteInsightCorpTaxRateBand(org.id, id);
  if (req.body.new_rate_band_date && req.body.new_rate_band_pct !== '') {
    const pct = parseFloat(req.body.new_rate_band_pct);
    if (Number.isFinite(pct)) addInsightCorpTaxRateBand(org.id, req.body.new_rate_band_date, pct);
  }

  // Corp tax addback / deduct-other / capital-allowance lists: each submitted as parallel arrays.
  const syncAdjustmentList = (type, codesField, pctField, treatmentField) => {
    const codes = req.body[codesField];
    const codeList = codes == null ? [] : (Array.isArray(codes) ? codes : [codes]);
    const pcts = req.body[pctField];
    const pctList = pcts == null ? [] : (Array.isArray(pcts) ? pcts : [pcts]);
    const treatments = treatmentField ? req.body[treatmentField] : null;
    const treatmentList = treatments == null ? [] : (Array.isArray(treatments) ? treatments : [treatments]);
    const keep = new Set(codeList);
    for (const existing of getInsightCorpTaxAdjustments(org.id, type)) {
      if (!keep.has(existing.account_code)) deleteInsightCorpTaxAdjustment(org.id, type, existing.account_code);
    }
    codeList.forEach((code, i) => {
      const pct = parseFloat(pctList[i]);
      setInsightCorpTaxAdjustment(org.id, type, code, {
        pct: Number.isFinite(pct) ? pct : 100,
        treatment: treatmentField ? (treatmentList[i] || null) : null,
      });
    });
  };
  syncAdjustmentList('addback', 'addback_code', 'addback_pct');
  syncAdjustmentList('deduct_other', 'deduct_code', 'deduct_pct');
  syncAdjustmentList('capital_allowance', 'capallow_code', 'capallow_pct', 'capallow_treatment');

  res.redirect(`/client/${encodeURIComponent(req.params.tenantId)}/insight/settings?saved=1`);
});

router.post('/:tenantId/sync', verifyCsrf, async (req, res) => {
  const { tenantId } = req.params;
  const org = getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).json({ error: 'Organisation not found' });
  let period;
  try {
    period = periodInput(req.query, org.period_type || getSetting('default_sync_period') || 'since_lock_date');
    selectedPeriodFor(org, req.query);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const started = startJob(
    `${tenantId}:all:${period.type}:${period.from || ''}:${period.to || ''}`,
    progress => syncOrganisation(tenantId, progress, { period }),
    { tenantId, orgId: org.id, mode: 'full', payload: { period } }
  );
  return res.status(started.existing ? 200 : 202).json({
    success: true, jobId: started.job.id, existing: started.existing,
  });
});

router.post('/:tenantId/check/:checkType/reanalyse', verifyCsrf, async (req, res) => {
  const { tenantId, checkType } = req.params;
  const org = getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).json({ error: 'Organisation not found' });
  if (!CHECK_DEFINITIONS.some(check => check.type === checkType)) {
    return res.status(404).json({ error: 'Unknown check type' });
  }
  let period, resolvedPeriod;
  try {
    period = periodInput(req.query, org.period_type || getSetting('default_sync_period') || 'since_lock_date');
    resolvedPeriod = selectedPeriodFor(org, req.query);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  // Only skip the live Xero fetch when reanalysing for a genuinely different period than the one
  // currently active for this client — that's the "preview this one check under a different
  // period using what's already cached" case the stale-period banner exists for. Reanalysing the
  // SAME period this dashboard already shows is this button's original, more common use — e.g.
  // after fixing a mis-coded transaction in Xero, or changing a threshold setting — and must still
  // do a real fetch, or it silently keeps showing the pre-fix result with no way to force a retry.
  const cacheOnly = shouldUseCacheOnlyForReanalysis(org.period_key, resolvedPeriod.key);
  // Escape hatch for a suspected-stale cache: incrementalSince (xeroSync.js) only re-fetches
  // entities Xero itself reports as modified since the last watermark, so a record whose content
  // changed WITHOUT bumping its own UpdatedDateUTC (confirmed happening for at least one bank
  // transaction's reconciliation flag) would never be picked up by an ordinary reanalyse. This
  // bypasses that and re-fetches everything live, same as a brand-new client's first sync.
  const forceFullRefresh = req.query.forceFullRefresh === '1';
  const started = startJob(
    `${tenantId}:${checkType}:${period.type}:${period.from || ''}:${period.to || ''}`,
    progress => syncOrganisation(tenantId, progress, {
      period, checkType, cacheOnly, asOf: resolvedPeriod.end, forceFullRefresh,
    }),
    {
      tenantId, orgId: org.id, mode: `check:${checkType}`,
      payload: { period, checkType, cacheOnly, asOf: resolvedPeriod.end, forceFullRefresh },
    }
  );
  return res.status(started.existing ? 200 : 202).json({
    success: true, jobId: started.job.id, existing: started.existing,
  });
});

router.post('/:tenantId/update', express.urlencoded({ extended: true }), verifyCsrf, (req, res) => {
  const { tenantId } = req.params;
  const org = getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const client_ref = 'client_ref' in req.body ? req.body.client_ref : org.client_ref;
  const tag = 'tag' in req.body ? req.body.tag : org.tag;
  updateOrganisationMeta(tenantId, { client_ref, tag });
  res.redirect(`/client/${tenantId}`);
});

// The client-list "Team Member Access" +/- popover's quick single-pair toggle — a convenience
// shortcut over /staff/:id/edit's full-page "replace the whole set" editor, writing to the same
// staff_org_access join table via toggleStaffOrgAccess. Admin-only: only admins manage access.
router.post('/:tenantId/access', express.urlencoded({ extended: true }), verifyCsrf, async (req, res, next) => {
  if (!isStaffManager(req.session.staffRole)) return res.status(403).send('Admin access required');
  const { tenantId } = req.params;
  const org = getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const staffId = Number(req.body.staff_id);
  if (!Number.isFinite(staffId)) return res.status(400).send('Missing staff_id');
  try {
    await toggleStaffOrgAccess(staffId, org.id, req.body.grant === '1');
    res.redirect('/');
  } catch (error) {
    next(error);
  }
});

router.get('/:tenantId/report', (req, res) => {
  const org = getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  try {
    const data = clientViewData(org, req.query);
    const reportFindings = getReportFindings(org.id, 50);
    res.render('report', {
      ...data,
      reportFindings,
      generatedAt: new Date().toISOString(),
      practiceLogo: getSetting('practice_logo') || '',
      practiceName: getSetting('practice_name') || 'Akrio Verify',
    });
  } catch (error) {
    res.status(400).send(error.message);
  }
});

router.get('/:tenantId/report.pdf', async (req, res) => {
  const { tenantId } = req.params;
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    const page = await browser.newPage();
    // The internal self-request always hits our own plain-HTTP listener: Railway (and most
    // PaaS) terminate TLS at the edge, so the container itself never speaks HTTPS in production.
    // Only local dev, with its own self-signed cert server, actually listens over HTTPS locally.
    const useLocalTlsServer = process.env.XERO_REDIRECT_URI?.startsWith('https://') && process.env.NODE_ENV !== 'production';
    const protocol = useLocalTlsServer ? 'https' : 'http';
    const query = new URLSearchParams(req.query).toString();
    const url = `${protocol}://localhost:${process.env.PORT || 3000}/client/${encodeURIComponent(tenantId)}/report${query ? `?${query}` : ''}`;
    await page.goto(url, { waitUntil: 'networkidle2' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' } });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="health-report-${tenantId}.pdf"` });
    res.send(pdf);
  } catch (err) {
    res.status(500).send('PDF generation failed: ' + err.message);
  } finally {
    if (browser) await browser.close();
  }
});

module.exports = router;
