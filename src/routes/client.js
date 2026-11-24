const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const {
  getOrganisationByTenantId, getIssuesForOrg, getIssueByCheckType, updateOrganisationMeta,
  updateOrganisationSupplierPatternLookback,
  updateOrganisationCheckConfig,
  getTransactionCountsForOrg, getTransactionActivityForOrg, getBankReconciliationForOrg,
  getPeriodView, getIssuesForView, getIssueByCheckTypeForView, getScoringObservationsForRun, updateStatementBalance,
  getExcludedBankAccountIds, setBankAccountExcluded, getLatestStatementImportsForOrg,
  getExpenseAccountsForOrg, getAccountCheckConfigurationForOrg,
  setAccountCheckConfiguration, ensureAccountCodes, getLiveScreenItemTotal, getIssueFindings, getIssueFindingSummary, setFindingReviewStates,
  setLineReviewState, getLineReviewStates, setFindingNote, getFindingNotes, getAllFindingKeysForIssue,
  addContactExclusion,
  createStatementImport, deleteStatementImport, getStatementImportByHash, getStatementImportsForOrg,
  getXeroBankItemsForOrg, getFiledAccountsForOrg, getFiledAccountsExtractionsForOrg,
  upsertFiledAccounts, getReportFindings, getSetting, getEntityCacheWatermark, getAllStaff,
  getCompaniesHouseProfileForOrg, updateOrganisationCompanyNumber, upsertCompaniesHouseProfile,
  toggleStaffOrgAccess, getAllInsightData, saveInsightData, getInsightData,
  getInsightAccountMappings, setInsightAccountMapping, getInsightCategorySettings, setInsightCategorySetting,
  getInsightWidgetVisibility, setInsightWidgetVisibility,
  getInsightSettingsKv, setInsightSettingsKv,
  getInsightCorpTaxRateBands, addInsightCorpTaxRateBand, deleteInsightCorpTaxRateBand,
  getInsightCorpTaxAdjustments, setInsightCorpTaxAdjustment, deleteInsightCorpTaxAdjustment, getReviewFrom,
} = require('../db/queries');
const { syncOrganisation, CHECK_DEFINITIONS } = require('../services/xeroSync');
const { xeroLinks } = require('../services/xeroLinks');
const { formatTurnoverGbp, groupSupplierTransactions } = require('../services/checkPresentation');
const { syncFreeAgentOrganisation } = require('../services/freeagentSync');
const { CASH_HEALTH_CATEGORIES, syncInsight } = require('../services/insightSync');
const { resolveCheckDisplayStatus, isCapitalDefaultAccount, NON_SCORED_CHECKS } = require('../services/checkRules');
const { calculateScoreBreakdown } = require('../services/scoreProfile');
const { fetchCompanyProfile, normalizeCompanyNumber } = require('../services/companiesHouse');
const {
  periodInput, resolvePeriod, shouldUseCacheOnlyForReanalysis, periodMenu, storedPeriodLabel,
  isNormalPeriod, periodKeyLabel,
} = require('../services/periodResolver');
const { startJob } = require('../services/syncJobs');
const { accessChanges } = require('../services/staffAccess');
const { hydrateOrgIfEmpty } = require('../db/xeroCacheStore');
const checkDescriptions = require('../data/checkDescriptions');
const { buildBankEvidence, loadLatestBankScreenReading } = require('../services/bankEvidence');
const {
  matchStatementLines, normalizeStatementLines, recomputeEvidenceIssues, sha256
} = require('../services/statementEvidence');
const puppeteer = require('puppeteer');
const { resolveOrgAccess } = require('../middleware/orgAccess');
const { isStaffManager } = require('../services/staffPermissions');
const { parseBankLineFilters, sendBankLinesCsv, bankLinesPageData } = require('./bankLinesShared');

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
      label: storedPeriodLabel(org),
      monthsCovered: 1,
    });
  }
  const fallback = org.period_type || getSetting('default_sync_period') || 'since_lock_date';
  return resolvePeriod(periodInput(query, fallback), periodContextFor(org));
}

// What a client's periods are worked out from: its review start (lock date or signed accounts) and year end.
function periodContextFor(org) {
  const reviewFrom = getReviewFrom(org);
  return {
    lockDate: reviewFrom.date,
    lockSource: reviewFrom.source,
    financialYearEndDay: org.financial_year_end_day,
    financialYearEndMonth: org.financial_year_end_month,
  };
}

// The period dropdown with this client's own dates; never lets a bad year end break the page.
function periodMenuFor(org) {
  try { return periodMenu(periodContextFor(org)); } catch (error) { return null; }
}

// "Show data up to" on the Insight tab: a real date, not in the future. Anything else means "latest".
function insightDateFrom(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return null;
  if (text < '2000-01-01' || text > new Date().toISOString().slice(0, 10)) return null;
  return text;
}

// ---- Period views ----
// The client's NORMAL period is the one its last sync ran with (org.period_key). Any other period chosen on the
// page is shown from a "period view": the same checks worked out from stored data and kept beside the normal
// results, so looking at another period never changes them. FreeAgent clients have no views.
function periodViewFor(org, query = {}) {
  const selectedPeriod = selectedPeriodFor(org, query);
  const isOtherPeriod = !isNormalPeriod(org, selectedPeriod);
  const view = isOtherPeriod && !org.freeagent_company_id ? getPeriodView(org.id, selectedPeriod.key) : null;
  return { selectedPeriod, isOtherPeriod, view };
}
// Never lets a bad period in a link or form break a check page: falls back to the normal results.
function safePeriodView(org, query) {
  try { return periodViewFor(org, query); } catch (error) { return { selectedPeriod: null, isOtherPeriod: false, view: null }; }
}
// "period=...&from=...&to=..." for links and forms while a view is on screen; '' for the normal period.
function viewQueryString(selectedPeriod, view) {
  if (!view || !selectedPeriod) return '';
  return new URLSearchParams({
    period: selectedPeriod.type,
    ...(selectedPeriod.type === 'custom' ? { from: selectedPeriod.start, to: selectedPeriod.end } : {}),
  }).toString();
}
// The client record as the page should show it for a view: that period's score, totals and labels. The score is
// worked out now, so a finding dismissed a moment ago is already reflected.
function orgAsViewed(org, view, selectedPeriod, issues) {
  const breakdown = calculateScoreBreakdown(getScoringObservationsForRun(org.id, view.runId, null, view.preserved), {
    nonScoredChecks: NON_SCORED_CHECKS, asOf: new Date(`${selectedPeriod.end}T00:00:00.000Z`),
  });
  const scored = issues.filter(issue => !NON_SCORED_CHECKS.includes(issue.check_type));
  return {
    ...org,
    score: breakdown.score,
    total_issues: scored.reduce((sum, issue) => sum + (issue.count || 0), 0),
    total_potential_errors_gbp: scored.reduce((sum, issue) => sum + (issue.potential_value_gbp || 0), 0),
    unreconciled_bank_items: issues.find(issue => issue.check_type === 'unreconciled_bank_items')?.count || 0,
    score_breakdown_json: JSON.stringify(breakdown), score_profile_version: breakdown.profileVersion,
    period_key: selectedPeriod.key, period_type: selectedPeriod.type, period_start: selectedPeriod.start,
    period_end: selectedPeriod.end, period_label: selectedPeriod.label,
  };
}

function clientViewData(liveOrg, query = {}) {
  const { selectedPeriod, view } = periodViewFor(liveOrg, query);
  const viewIssues = view ? getIssuesForView(view) : null;
  const org = view ? orgAsViewed(liveOrg, view, selectedPeriod, viewIssues) : liveOrg;
  const insightDate = org.xero_tenant_id ? insightDateFrom(query.insight_to) : null;
  const periodQuery = new URLSearchParams({
    period: selectedPeriod.type,
    ...(selectedPeriod.type === 'custom' ? { from: selectedPeriod.start, to: selectedPeriod.end } : {}),
  }).toString();
  const issues = viewIssues || getIssuesForOrg(org.id);
  const checkDefs = CHECK_DEFINITIONS.map(def => {
    const issue = issues.find(i => i.check_type === def.type);
    const merged = { ...def, ...(issue || { count: null, potential_value_gbp: 0 }) };
    if (issue && def.type === 'unprocessed_bank') merged.screenItems = getLiveScreenItemTotal(issue.id);
    // Single source of truth for what this check's state means — the template must never re-derive
    // this from its own period_checked string comparisons (see checkRules.js/periodStatus.js).
    return { ...merged, displayStatus: resolveCheckDisplayStatus(merged) };
  });
  return {
    org, issues, checkDefs, selectedPeriod, periodQuery, periodMenu: periodMenuFor(liveOrg),
    // Set while another period is on screen: what the client's normal period is, and when the view was worked out.
    periodView: view ? { normalLabel: storedPeriodLabel(liveOrg), builtAt: view.builtAt } : null,
    isStale: !org.last_successful_sync_at ||
      Date.now() - new Date(org.last_successful_sync_at).getTime() > 36 * 60 * 60 * 1000,
    // Any period, added up from the per-day figures; the last sync's stored totals only if there are none yet.
    txCounts: getTransactionActivityForOrg(org.id, selectedPeriod)
      || getTransactionCountsForOrg(org.id, selectedPeriod.type, selectedPeriod.start, selectedPeriod.end),
    bankReconciliation: getBankReconciliationForOrg(org.id),
    excludedBankAccountIds: getExcludedBankAccountIds(org.id),
    statementImports: getStatementImportsForOrg(org.id),
    filedAccounts: getFiledAccountsForOrg(org.id),
    filedAccountsExtractions: getFiledAccountsExtractionsForOrg(org.id),
    companiesHouse: getCompaniesHouseProfileForOrg(org.id),
    companiesHouseKeySet: !!getSetting('companies_house_api_key'),
    expenseAccounts: getExpenseAccountsForOrg(org.id),
    // capitalDefault: watched for Capital Item Review by the practice default, whether or not it is ticked.
    accountConfigurations: getAccountCheckConfigurationForOrg(org.id).map(account => ({
      ...account, capitalDefault: isCapitalDefaultAccount({ type: account.account_type, name: account.account_name }),
    })),
    scoreBreakdown: parseScoreBreakdown(org),
    insight: getAllInsightData(org.id, insightDate),
    insightDate,
    insightKv: getInsightSettingsKv(org.id),
    insightMappings: getInsightAccountMappings(org.id),
    insightWidgetVisibility: getInsightWidgetVisibility(org.id),
    checkDescriptions,
    formatTurnoverGbp,
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

function verifyCsrf(req, res, next) {
  const supplied = req.body?.csrf_token || req.get('x-csrf-token');
  if (!req.session.csrfToken || supplied !== req.session.csrfToken) {
    return res.status(403).send('Invalid form token');
  }
  next();
}

router.get('/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const org = await getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  try {
    res.render('client', clientViewData(org, req.query));
  } catch (error) {
    res.status(400).send(error.message);
  }
});

// Every bank transaction line with the chart-of-accounts account it was coded to (from MySQL, so it
// survives deploys). Filled by each sync from the bank transactions Akrio already downloads.
router.get('/:tenantId/bank-lines', async (req, res, next) => {
  try {
    const org = await getOrganisationByTenantId(req.params.tenantId);
    const filters = { ...parseBankLineFilters(req.query), orgIds: [org.id] };
    const data = await bankLinesPageData(filters, req.query.page);
    res.render('bankLines', {
      viewScope: 'client', org, clients: [], data, filters, query: req.query,
      formAction: `${res.locals.basePath || ''}/client/${org.xero_tenant_id || org.freeagent_company_id}/bank-lines`,
    });
  } catch (error) { next(error); }
});

router.get('/:tenantId/bank-lines.csv', async (req, res, next) => {
  try {
    const org = await getOrganisationByTenantId(req.params.tenantId);
    const filters = { ...parseBankLineFilters(req.query), orgIds: [org.id] };
    await sendBankLinesCsv(res, filters, `bank-lines-${String(org.name).replace(/[^a-z0-9]+/gi, '_')}.csv`);
  } catch (error) { if (res.headersSent) res.end(); else next(error); }
});

router.get('/:tenantId/score-breakdown', async (req, res) => {
  const org = await getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).json({ error: 'Organisation not found' });
  const breakdown = parseScoreBreakdown(org);
  if (!breakdown) return res.status(404).json({ error: 'No scored sync is available' });
  res.json(breakdown);
});

router.post('/:tenantId/account-check-configuration', express.urlencoded({ extended: true }), verifyCsrf, async (req, res) => {
  const { tenantId } = req.params;
  const org = await getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  // `ensure_codes` (comma list) lets a bulk import name accounts whose chart-of-accounts row has not
  // been cached yet (e.g. right after a restart, before the next sync); the next sync fills in the
  // names and types without touching the settings saved here.
  ensureAccountCodes(org.id, String(req.body.ensure_codes || '').split(',').map(c => c.trim()).filter(Boolean));
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
  // A misallocated threshold of 0 is a real setting ("flag everything"), unlike the other thresholds.
  const nonNegativeNumber = value => {
    if (value === '' || value == null) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const configurations = accounts.map(account => ({
    account_code: account.account_code,
    is_capital_candidate: capital.has(account.account_code),
    capital_review_threshold: positiveNumber(req.body.capital_threshold?.[account.account_code]),
    monitor_misallocated: misallocated.has(account.account_code),
    misallocated_threshold: nonNegativeNumber(req.body.misallocated_threshold?.[account.account_code]),
    purchase_tax_ignore: taxIgnored.has(account.account_code),
    purchase_tax_include_asset_prepayment: taxIncluded.has(account.account_code),
  }));
  await setAccountCheckConfiguration(org.id, configurations);
  res.redirect(`/client/${tenantId}#capital-review-accounts`);
});

router.post('/:tenantId/supplier-pattern-lookback', express.urlencoded({ extended: true }), async (req, res) => {
  const { tenantId } = req.params;
  const org = await getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  if (!req.session.csrfToken || req.body.csrf_token !== req.session.csrfToken) {
    return res.status(403).send('Invalid form token');
  }
  const months = parseInt(req.body.supplier_pattern_lookback_months, 10);
  await updateOrganisationSupplierPatternLookback(org.id, Number.isFinite(months) ? months : null);
  res.redirect(`/client/${tenantId}#supplier-pattern-lookback`);
});

router.post('/:tenantId/check-config', express.urlencoded({ extended: true }), async (req, res) => {
  const { tenantId } = req.params;
  const org = await getOrganisationByTenantId(tenantId);
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
  await updateOrganisationCheckConfig(org.id, {
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

router.post('/:tenantId/bank-reconciliation', express.urlencoded({ extended: true }), verifyCsrf, async (req, res) => {
  const { tenantId } = req.params;
  const { bank_account_id, statement_balance } = req.body;
  const org = await getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const parsed = parseFloat(statement_balance);
  updateStatementBalance(org.id, bank_account_id, isNaN(parsed) ? null : parsed);
  await recomputeEvidenceIssues(org.id);
  res.redirect(`/client/${tenantId}#bank-reconciliation`);
});

router.post('/:tenantId/bank-account-exclusion', express.urlencoded({ extended: true }), verifyCsrf, async (req, res) => {
  const { tenantId } = req.params;
  const { bank_account_id, excluded } = req.body;
  const org = await getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  if (!bank_account_id) return res.status(400).send('bank_account_id is required');
  // Xenon supports excluding individual bank accounts from Bank Balance and Unreconciled Bank
  // Items — organisation-scoped, so this can never affect another client's account, even one that
  // happens to share the same Xero bank_account_id (accounts are keyed by (org_id, account_id)).
  setBankAccountExcluded(org.id, bank_account_id, excluded === '1' || excluded === 'true');
  await recomputeEvidenceIssues(org.id);
  res.redirect(`/client/${tenantId}#bank-reconciliation`);
});

router.post('/:tenantId/statement-import', acceptStatementUpload, async (req, res) => {
  const { tenantId } = req.params;
  const org = await getOrganisationByTenantId(tenantId);
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
    await recomputeEvidenceIssues(org.id);
    res.redirect(`/client/${encodeURIComponent(tenantId)}#statement-evidence`);
  } catch (error) {
    res.status(400).send(error.message);
  }
});

router.post('/:tenantId/statement-import/:importId/delete', express.urlencoded({ extended: true }), verifyCsrf, async (req, res) => {
  const org = await getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const removed = deleteStatementImport(org.id, Number(req.params.importId));
  if (!removed) return res.status(404).send('Statement import not found');
  const safeName = path.basename(removed.stored_filename);
  if (safeName === removed.stored_filename) fs.rmSync(path.join(evidenceDir, safeName), { force: true });
  await recomputeEvidenceIssues(org.id);
  res.redirect(`/client/${encodeURIComponent(req.params.tenantId)}#statement-evidence`);
});

router.post('/:tenantId/filed-accounts', acceptSourceDocument, async (req, res) => {
  const org = await getOrganisationByTenantId(req.params.tenantId);
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
  await recomputeEvidenceIssues(org.id);
  res.redirect(`/client/${encodeURIComponent(req.params.tenantId)}#filed-accounts`);
});

router.post('/:tenantId/companies-house', express.urlencoded({ extended: true }), verifyCsrf, async (req, res) => {
  const org = await getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const number = normalizeCompanyNumber(req.body.company_number);
  if (!number) return res.status(400).send('Enter a valid company number');
  await updateOrganisationCompanyNumber(org.id, number);
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

router.get('/:tenantId/check/:checkType', async (req, res) => {
  const { tenantId, checkType } = req.params;
  const org = await getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const { selectedPeriod: viewedPeriod, view } = safePeriodView(org, req.query);
  const issue = view ? getIssueByCheckTypeForView(view, checkType) : getIssueByCheckType(org.id, checkType);
  const def = CHECK_DEFINITIONS.find(d => d.type === checkType);
  let pagination = { items: [], page: 1, pageSize: 50, total: 0, totalPages: 1 };
  let summary = { active: 0, dismissed: 0, ignored: 0, ok: 0, previous: 0 };
  // The 3 months before the review period, listed after the period's findings (context only, never counted).
  let previousPagination = { items: [], page: 1, pageSize: 50, total: 0, totalPages: 1 };
  const status = ['active', 'dismissed', 'ignored', 'ok', 'all'].includes(req.query.status)
    ? req.query.status : 'all';
  const contact = typeof req.query.contact === 'string' ? req.query.contact.trim().slice(0, 100) : '';
  if (issue) {
    pagination = getIssueFindings(issue.id, org.id, req.query.page, 50, status, contact);
    summary = getIssueFindingSummary(issue.id, org.id);
    // Shown under the Active and All tabs; the Dismissed/Ignored/OK tabs list review-period findings only.
    if (status === 'active' || status === 'all') {
      previousPagination = getIssueFindings(issue.id, org.id, req.query.ppage, 50, 'all', contact, 'previous');
    }
    if (pagination.total === 0 && issue.detail_json && !contact) {
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
  // The client's Xero short code, so links open the right client through Xero's organisation switch. A page must
  // never fail because it cannot be found; links then fall back to the document's own page or none.
  let linkContext = {};
  try {
    const { getShortCodeIndex } = require('../db/bankScreenReadings');
    linkContext = { shortCode: (await getShortCodeIndex()).byOrg.get(org.id) };
  } catch (error) { console.error('[check] Xero short code unavailable:', error.message); }
  const decorate = item => {
    const lineReviews = Array.isArray(item.transactions) && item.transactions.length
      ? getLineReviewStates(org.id, checkType, item.finding_key)
      : {};
    return {
      ...item,
      // A FreeAgent client's documents are not in Xero, so Xero links would open the wrong place.
      xero_links: org.xero_tenant_id ? xeroLinks(checkType, item, linkContext) : [],
      standaloneNote: findingNotes[item.finding_key] || null,
      ageDays: (showAge && item.date) ? Math.floor((Date.now() - new Date(item.date).getTime()) / 86400000) : undefined,
      accountName: item.accountCode ? (item.accountName || accountNameByCode[item.accountCode] || null) : item.accountName,
      transactions: Array.isArray(item.transactions)
        ? item.transactions.map(tx => {
            const lineKey = tx.bankTransactionId || tx.invoiceId || tx.creditNoteId || null;
            return {
              ...tx,
              accountName: tx.accountCode ? (tx.accountName || accountNameByCode[tx.accountCode] || null) : tx.accountName,
              xero_links: org.xero_tenant_id ? xeroLinks(checkType, tx, linkContext) : [], lineKey, ...(lineKey ? lineReviews[lineKey] : {}),
            };
          })
        : undefined,
    };
  };
  const items = pagination.items.map(decorate);
  const previousItems = previousPagination.items.map(decorate);
  const extraData = {};
  if (checkType === 'bank_balance') {
    // Same evidence builder the check itself uses, so the cards always show the figures it compared.
    const bank = buildBankEvidence({
      reconciliation: getBankReconciliationForOrg(org.id),
      imports: getLatestStatementImportsForOrg(org.id),
      excludedBankAccountIds: getExcludedBankAccountIds(org.id),
      reading: await loadLatestBankScreenReading(org.id),
    });
    extraData.bankAccounts = bank.accounts;
    extraData.bankReading = bank.reading;
  }
  res.render('checkDetail', {
    // While another period is on screen every link and form on the page carries it, so paging, filtering and
    // reviewing stay in that period.
    viewQuery: viewQueryString(viewedPeriod, view),
    periodView: view ? { label: viewedPeriod.label, normalLabel: storedPeriodLabel(org) } : null,
    // "Period checked" in words: the label of the period that key belongs to, else the key's dates.
    periodCheckedLabel: !issue?.period_checked ? null
      : issue.period_checked === viewedPeriod.key ? viewedPeriod.label
        : issue.period_checked === org.period_key && org.period_label ? storedPeriodLabel(org)
          : periodKeyLabel(issue.period_checked),
    org, issue, def, items, pagination, previousItems, previousPagination, summary, status, contact, checkType, checkDescriptions, groupSupplierTransactions,
    displayStatus: issue ? resolveCheckDisplayStatus(issue) : null, ...extraData,
  });
});

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Flat CSV of every finding for one check (one row per underlying transaction where a finding
// carries them, e.g. multi-account/multi-tax suppliers), for comparing against Xenon's own export.
router.get('/:tenantId/check/:checkType/export.csv', async (req, res) => {
  const { tenantId, checkType } = req.params;
  const org = await getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const exportView = safePeriodView(org, req.query).view;
  const issue = exportView ? getIssueByCheckTypeForView(exportView, checkType) : getIssueByCheckType(org.id, checkType);
  if (!issue) return res.status(404).send('Check not found');
  const status = ['active', 'dismissed', 'ignored', 'ok', 'all'].includes(req.query.status) ? req.query.status : 'all';
  const rows = [];
  for (let page = 1; ; page++) {
    // Both the review period and the previous 3 months; previous-months rows carry lookback=true in their own column.
    const chunk = getIssueFindings(issue.id, org.id, page, 100, status, typeof req.query.contact === 'string' ? req.query.contact : '', 'any');
    for (const item of chunk.items) {
      const { transactions, ...parent } = item;
      if (Array.isArray(transactions) && transactions.length) {
        for (const tx of transactions) rows.push({ ...parent, ...Object.fromEntries(Object.entries(tx).map(([k, v]) => [`tx_${k}`, v])) });
      } else {
        rows.push(parent);
      }
    }
    if (page >= chunk.totalPages) break;
  }
  const columns = [...rows.reduce((set, row) => { Object.keys(row).forEach(k => set.add(k)); return set; }, new Set())];
  const csv = [columns.join(','), ...rows.map(row => columns.map(c => csvCell(row[c])).join(','))].join('\r\n');
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${checkType}-${tenantId}.csv"`,
  });
  res.send('﻿' + csv);
});

router.post(
  '/:tenantId/check/:checkType/review',
  express.urlencoded({ extended: true }),
  verifyCsrf,
  async (req, res) => {
    const { tenantId, checkType } = req.params;
    const org = await getOrganisationByTenantId(tenantId);
    if (!org) return res.status(404).send('Organisation not found');
    // "Ignore/Dismiss all N items" applies to every finding matching the current status filter,
    // not just the ones visible on this page — matches Xenon's own bulk buttons, which state the
    // full count regardless of pagination.
    // The page says which period it was showing (hidden fields); a review made in a period view applies to that
    // view's findings.
    const reviewed = safePeriodView(org, req.body);
    const viewSuffix = viewQueryString(reviewed.selectedPeriod, reviewed.view);
    let findingKeys;
    if (req.body.select_all === '1') {
      const issue = reviewed.view ? getIssueByCheckTypeForView(reviewed.view, checkType) : getIssueByCheckType(org.id, checkType);
      const bulkStatus = ['active', 'dismissed', 'ignored', 'ok', 'all'].includes(req.body.return_status)
        ? req.body.return_status : 'active';
      findingKeys = issue ? getAllFindingKeysForIssue(issue.id, org.id, bulkStatus) : [];
    } else {
      findingKeys = [req.body.finding_key || req.body.finding_keys].flat().filter(Boolean);
    }
    try {
      await setFindingReviewStates(org.id, checkType, findingKeys, req.body.action, req.body.notes,
        reviewed.view ? { viewRunId: reviewed.view.runId } : {});
    } catch (error) {
      return res.status(400).send(error.message);
    }
    const status = encodeURIComponent(req.body.return_status || 'active');
    const page = Math.max(1, Number(req.body.return_page) || 1);
    res.redirect(`/client/${encodeURIComponent(tenantId)}/check/${encodeURIComponent(checkType)}?status=${status}&page=${page}${viewSuffix ? '&' + viewSuffix : ''}`);
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
  async (req, res) => {
    const { tenantId, checkType } = req.params;
    const org = await getOrganisationByTenantId(tenantId);
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
  async (req, res) => {
    const { tenantId, checkType } = req.params;
    const org = await getOrganisationByTenantId(tenantId);
    if (!org) return res.status(404).send('Organisation not found');
    try {
      setFindingNote(org.id, checkType, req.body.finding_key, req.body.notes);
    } catch (error) {
      return res.status(400).send(error.message);
    }
    const status = encodeURIComponent(req.body.return_status || 'active');
    const page = Math.max(1, Number(req.body.return_page) || 1);
    const noted = safePeriodView(org, req.body);
    const noteSuffix = viewQueryString(noted.selectedPeriod, noted.view);
    res.redirect(`/client/${encodeURIComponent(tenantId)}/check/${encodeURIComponent(checkType)}?status=${status}&page=${page}${noteSuffix ? '&' + noteSuffix : ''}`);
  }
);

// "Ignore this contact" — a PERMANENT exclusion (contact_exclusions) applied on the NEXT
// sync/reanalyse of this check, not immediately; see addContactExclusion's comment for why.
router.post(
  '/:tenantId/check/:checkType/ignore-contact',
  express.urlencoded({ extended: true }),
  verifyCsrf,
  async (req, res) => {
    const { tenantId, checkType } = req.params;
    const org = await getOrganisationByTenantId(tenantId);
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

// Fetch the Insight figures as at another date. Read-only report calls to Xero (P&L, bank summary, balance
// sheet), queued like a sync so it never runs alongside one; the health checks and the normal Insight figures
// are not touched.
router.post('/:tenantId/insight/fetch', verifyCsrf, async (req, res) => {
  const org = await getOrganisationByTenantId(req.params.tenantId);
  if (!org || !org.xero_tenant_id) return res.status(404).json({ error: 'Organisation not found' });
  const date = insightDateFrom(req.query.date);
  if (!date) return res.status(400).json({ error: 'Choose a valid date that is not in the future' });
  try {
    const started = await startJob(
      `${org.xero_tenant_id}:insight:${date}`,
      async progress => {
        progress({ step: 'insight', message: 'Fetching Insight figures from Xero…' });
        const outcome = await syncInsight(org.xero_tenant_id, org.id, {
          toDate: date, cacheKey: date,
          fyEndMonth: org.financial_year_end_month || 3, fyEndDay: org.financial_year_end_day || 31,
        });
        const fetched = getAllInsightData(org.id, date);
        if (!fetched.pnl && !fetched.balance_sheet && !fetched.corp_tax) {
          throw new Error('Xero did not return the reports for this date' + (outcome.errors[0] ? ` (${outcome.errors[0]})` : ''));
        }
        return outcome;
      },
      { tenantId: org.xero_tenant_id, orgId: org.id, mode: 'insight', priority: true, maxAttempts: 1, payload: { insightDate: date } }
    );
    return res.status(started.existing ? 200 : 202).json({ success: true, jobId: started.job.id, existing: started.existing });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.post('/:tenantId/insight/target', express.urlencoded({ extended: true }), verifyCsrf, async (req, res) => {
  const org = await getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const val = parseFloat(req.body.monthly_target);
  if (Number.isFinite(val) && val >= 0) saveInsightData(org.id, 'target', { basis: 'fixed', monthly_target: val });
  res.redirect(`/client/${encodeURIComponent(req.params.tenantId)}?panel=insight`);
});

router.post('/:tenantId/insight/ctax-override', express.urlencoded({ extended: true }), verifyCsrf, async (req, res) => {
  const org = await getOrganisationByTenantId(req.params.tenantId);
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

router.get('/:tenantId/insight/settings', async (req, res) => {
  const org = await getOrganisationByTenantId(req.params.tenantId);
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

router.post('/:tenantId/insight/settings', express.urlencoded({ extended: true }), verifyCsrf, async (req, res) => {
  const org = await getOrganisationByTenantId(req.params.tenantId);
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

// A different date range can be worked out from the stored copy of the client's Xero data when that copy
// is under two days old and exists for this client. The same range as the active one still does a live sync.
const STORED_DATA_MAX_AGE_MS = 48 * 60 * 60 * 1000;
async function canRecalculateFromStoredData(org, resolvedPeriod) {
  if (!shouldUseCacheOnlyForReanalysis(org.period_key, resolvedPeriod.key)) return false;
  const syncedAt = org.last_synced_at ? new Date(org.last_synced_at).getTime() : 0;
  if (!syncedAt || Date.now() - syncedAt > STORED_DATA_MAX_AGE_MS) return false;
  await hydrateOrgIfEmpty(org.id);
  return Boolean(getEntityCacheWatermark(org.id, 'invoice'));
}

router.post('/:tenantId/sync', verifyCsrf, async (req, res) => {
  const { tenantId } = req.params;
  const org = await getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).json({ error: 'Organisation not found' });
  let period, resolvedPeriod;
  try {
    period = periodInput(req.query, org.period_type || getSetting('default_sync_period') || 'since_lock_date');
    resolvedPeriod = selectedPeriodFor(org, req.query);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  // Looking at a different date range than the one on screen: work it out from the data already stored
  // for this client instead of asking Xero for everything again (seconds, like Xenon, not minutes).
  // Only when the stored copy is recent; otherwise do the normal live sync so the numbers are not old.
  const cacheOnly = await canRecalculateFromStoredData(org, resolvedPeriod);
  // A period other than the client's normal one is worked out as a VIEW: from stored data, kept beside the
  // normal results and never replacing them. (Before this, it replaced the client's results until the next
  // nightly sync.) FreeAgent clients, and a client that has never been synced, are handled as before.
  const asView = !org.freeagent_company_id && !isNormalPeriod(org, resolvedPeriod);
  if (asView && !cacheOnly) {
    return res.status(409).json({ error: 'This client\'s stored Xero data is more than two days old. Sync the client first (with its normal period), then choose the period again.' });
  }
  const runSync = org.freeagent_company_id
    ? progress => syncFreeAgentOrganisation(tenantId, progress, { period, cacheOnly })
    : progress => syncOrganisation(tenantId, progress, { period, cacheOnly, view: asView });
  const started = await startJob(
    `${tenantId}:${asView ? 'view' : 'all'}:${period.type}:${period.from || ''}:${period.to || ''}`,
    runSync,
    // A view job is not restored after a restart (no "period" in its payload): it is simply asked for again.
    asView ? { tenantId, orgId: org.id, mode: 'view', priority: true, maxAttempts: 1, payload: { viewPeriod: period } }
      : { tenantId, orgId: org.id, mode: 'full', priority: true, payload: { period, cacheOnly } }
  );
  return res.status(started.existing ? 200 : 202).json({
    success: true, jobId: started.job.id, existing: started.existing,
  });
});

router.post('/:tenantId/check/:checkType/reanalyse', verifyCsrf, async (req, res) => {
  const { tenantId, checkType } = req.params;
  const org = await getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).json({ error: 'Organisation not found' });
  if (!CHECK_DEFINITIONS.some(check => check.type === checkType)) {
    return res.status(404).json({ error: 'Unknown check type' });
  }
  // FreeAgent sync (Stage 1) only supports full syncs — see the comment at the top of
  // freeagentSync.js. A scoped reanalyse here only persists the issue row for `checkType`
  // and reactivates just that one, leaving every other check's issue row untouched/inactive,
  // so it silently reads as "Not synced" on the dashboard until a real full sync runs.
  if (org.freeagent_company_id) {
    return res.status(400).json({ error: 'Per-check reanalyse is not yet supported for FreeAgent clients — run a full sync instead.' });
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
  const runSync = org.freeagent_company_id
    ? progress => syncFreeAgentOrganisation(tenantId, progress, {
      period, checkType, cacheOnly, asOf: resolvedPeriod.end, forceFullRefresh,
    })
    : progress => syncOrganisation(tenantId, progress, {
      period, checkType, cacheOnly, asOf: resolvedPeriod.end, forceFullRefresh,
    });
  const started = await startJob(
    `${tenantId}:${checkType}:${period.type}:${period.from || ''}:${period.to || ''}`,
    runSync,
    {
      tenantId, orgId: org.id, mode: `check:${checkType}`, priority: true,
      payload: { period, checkType, cacheOnly, asOf: resolvedPeriod.end, forceFullRefresh },
    }
  );
  return res.status(started.existing ? 200 : 202).json({
    success: true, jobId: started.job.id, existing: started.existing,
  });
});

router.post('/:tenantId/update', express.urlencoded({ extended: true }), verifyCsrf, async (req, res) => {
  const { tenantId } = req.params;
  const org = await getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const client_ref = 'client_ref' in req.body ? req.body.client_ref : org.client_ref;
  const tag = 'tag' in req.body ? req.body.tag : org.tag;
  await updateOrganisationMeta(tenantId, { client_ref, tag });
  res.redirect(`/client/${tenantId}`);
});

// The client-list "Team Member Access" +/- popover's quick single-pair toggle — a convenience
// shortcut over /staff/:id/edit's full-page "replace the whole set" editor, writing to the same
// staff_org_access join table via toggleStaffOrgAccess. Admin-only: only admins manage access.
router.post('/:tenantId/access', express.urlencoded({ extended: true }), verifyCsrf, async (req, res, next) => {
  if (!isStaffManager(req.session.staffRole)) return res.status(403).send('Admin access required');
  const { tenantId } = req.params;
  const org = await getOrganisationByTenantId(tenantId);
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

// The same "Team Member Access" popover, saving a whole ticked list in one go (several people at once).
router.post('/:tenantId/access/bulk', express.urlencoded({ extended: true }), verifyCsrf, async (req, res, next) => {
  if (!isStaffManager(req.session.staffRole)) return res.status(403).send('Admin access required');
  const org = await getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  try {
    const activeIds = (await getAllStaff()).filter(s => s.is_active).map(s => s.id);
    const { grant, revoke } = accessChanges(req.body.grant_ids, req.body.revoke_ids, activeIds);
    for (const staffId of grant) await toggleStaffOrgAccess(staffId, org.id, true);
    for (const staffId of revoke) await toggleStaffOrgAccess(staffId, org.id, false);
    res.redirect('/');
  } catch (error) {
    next(error);
  }
});

router.get('/:tenantId/report', async (req, res) => {
  const org = await getOrganisationByTenantId(req.params.tenantId);
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
    const basePath = (process.env.AKRIO_BASE_PATH || '').replace(/\/$/, '');
    const url = `${protocol}://localhost:${process.env.PORT || 3000}${basePath}/client/${encodeURIComponent(tenantId)}/report${query ? `?${query}` : ''}`;
    // The internal request must carry the caller's staff session, otherwise the report route
    // redirects to the login page and that is what gets printed into the PDF.
    await page.setExtraHTTPHeaders({ cookie: req.headers.cookie || '', 'x-forwarded-proto': 'https' });
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
