const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const {
  getOrganisationByTenantId, getIssuesForOrg, getIssueByCheckType, updateOrganisationMeta,
  updateOrganisationSupplierPatternLookback,
  getTransactionCountsForOrg, getBankReconciliationForOrg, updateStatementBalance,
  getExpenseAccountsForOrg, getAccountCheckConfigurationForOrg,
  setAccountCheckConfiguration, getIssueFindings, getIssueFindingSummary, setFindingReviewStates,
  createStatementImport, deleteStatementImport, getStatementImportByHash, getStatementImportsForOrg,
  getXeroBankItemsForOrg, getFiledAccountsForOrg, getFiledAccountsExtractionsForOrg,
  upsertFiledAccounts, getReportFindings, getSetting,
  getCompaniesHouseProfileForOrg, updateOrganisationCompanyNumber, upsertCompaniesHouseProfile
} = require('../db/queries');
const { syncOrganisation, CHECK_DEFINITIONS } = require('../services/xeroSync');
const { fetchCompanyProfile, normalizeCompanyNumber } = require('../services/companiesHouse');
const { periodInput, resolvePeriod } = require('../services/periodResolver');
const { startJob } = require('../services/syncJobs');
const {
  matchStatementLines, normalizeStatementLines, recomputeEvidenceIssues, sha256
} = require('../services/statementEvidence');
const puppeteer = require('puppeteer');

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
    return { ...def, ...(issue || { count: null, potential_value_gbp: 0 }) };
  });
  return {
    org, issues, checkDefs, selectedPeriod, periodQuery,
    isStale: !org.last_successful_sync_at ||
      Date.now() - new Date(org.last_successful_sync_at).getTime() > 36 * 60 * 60 * 1000,
    txCounts: getTransactionCountsForOrg(org.id, selectedPeriod.type, selectedPeriod.start, selectedPeriod.end),
    bankReconciliation: getBankReconciliationForOrg(org.id),
    statementImports: getStatementImportsForOrg(org.id),
    filedAccounts: getFiledAccountsForOrg(org.id),
    filedAccountsExtractions: getFiledAccountsExtractionsForOrg(org.id),
    companiesHouse: getCompaniesHouseProfileForOrg(org.id),
    companiesHouseKeySet: !!getSetting('companies_house_api_key'),
    expenseAccounts: getExpenseAccountsForOrg(org.id),
    accountConfigurations: getAccountCheckConfigurationForOrg(org.id),
    scoreBreakdown: parseScoreBreakdown(org),
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
  if (!req.session.csrfToken || req.body.csrf_token !== req.session.csrfToken) {
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

router.post('/:tenantId/account-check-configuration', express.urlencoded({ extended: true }), (req, res) => {
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
  res.redirect(`/client/${tenantId}#supplier-pattern-lookback`);
});

router.post('/:tenantId/bank-reconciliation', express.urlencoded({ extended: true }), (req, res) => {
  const { tenantId } = req.params;
  const { bank_account_id, statement_balance } = req.body;
  const org = getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  const parsed = parseFloat(statement_balance);
  updateStatementBalance(org.id, bank_account_id, isNaN(parsed) ? null : parsed);
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
    ? req.query.status : 'active';
  if (issue) {
    pagination = getIssueFindings(issue.id, req.query.page, 50, status);
    summary = getIssueFindingSummary(issue.id);
    if (pagination.total === 0 && issue.detail_json) {
      try {
        pagination.items = JSON.parse(issue.detail_json);
        pagination.total = pagination.items.length;
      } catch (error) {
        pagination.items = [];
      }
    }
  }
  const items = pagination.items.map(item => ({ ...item, xero_links: xeroLinks(checkType, item) }));
  res.render('checkDetail', { org, issue, def, items, pagination, summary, status, checkType });
});

router.post(
  '/:tenantId/check/:checkType/review',
  express.urlencoded({ extended: true }),
  verifyCsrf,
  (req, res) => {
    const { tenantId, checkType } = req.params;
    const org = getOrganisationByTenantId(tenantId);
    if (!org) return res.status(404).send('Organisation not found');
    const findingKeys = [req.body.finding_key || req.body.finding_keys].flat().filter(Boolean);
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

router.post('/:tenantId/sync', async (req, res) => {
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

router.post('/:tenantId/check/:checkType/reanalyse', async (req, res) => {
  const { tenantId, checkType } = req.params;
  const org = getOrganisationByTenantId(tenantId);
  if (!org) return res.status(404).json({ error: 'Organisation not found' });
  if (!CHECK_DEFINITIONS.some(check => check.type === checkType)) {
    return res.status(404).json({ error: 'Unknown check type' });
  }
  let period;
  try {
    period = periodInput(req.query, org.period_type || getSetting('default_sync_period') || 'since_lock_date');
    selectedPeriodFor(org, req.query);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const started = startJob(
    `${tenantId}:${checkType}:${period.type}:${period.from || ''}:${period.to || ''}`,
    progress => syncOrganisation(tenantId, progress, {
      period, checkType, cacheOnly: true, asOf: org.period_end || undefined,
    }),
    {
      tenantId, orgId: org.id, mode: `check:${checkType}`,
      payload: { period, checkType, cacheOnly: true, asOf: org.period_end || undefined },
    }
  );
  return res.status(started.existing ? 200 : 202).json({
    success: true, jobId: started.job.id, existing: started.existing,
  });
});

router.post('/:tenantId/update', express.urlencoded({ extended: true }), (req, res) => {
  const { tenantId } = req.params;
  const { client_ref, tag } = req.body;
  updateOrganisationMeta(tenantId, { client_ref, tag });
  res.redirect(`/client/${tenantId}`);
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
      practiceName: getSetting('practice_name') || 'Xero Health Dashboard',
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
