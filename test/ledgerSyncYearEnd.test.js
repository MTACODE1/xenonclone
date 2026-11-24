// A Zoho Books (or QuickBooks) sync saves the year end its company settings give, the way the Xero sync does
// (updateOrganisationAccountingSettings), so the client page's period menu uses it instead of the default 31/03.
// The database, cache, checks and ledger are stand-ins; nothing reaches a real ledger or database. Made-up data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const saved = [];
let cachedRows = [{ cached: true }];
let failSave = false;
const stub = (relative, exports) => {
  const file = require.resolve(relative);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub('../src/db/queries', {
  getOrganisationByFreeAgentCompanyId: async id => ({ id: 77, name: 'Made Up FZ LLC', freeagent_company_id: id }),
  upsertFreeAgentOrganisation: async () => {},
  markOrganisationDisconnectedByFreeAgentCompany: async () => {},
  mergeEntityCacheAsync: async () => {},
  getCachedEntitiesAsync: async () => cachedRows,
  createSyncRun: async () => 501,
  finishSyncRun: async () => {},
  updateOrganisationAccountingSettings: async (orgId, data) => {
    if (failSave) throw new Error('database unavailable');
    saved.push({ orgId, ...data });
  },
});
stub('../src/db/xeroCacheStore', { hydrateOrgIfEmpty: async () => {}, drain: async () => {} });
stub('../src/db/orgCurrency', { saveOrgCurrency: async () => {}, getStoredOrgCurrency: async () => 'AED' });
let seenPeriod = null;
stub('../src/services/ledgerChecks', {
  runLedgerChecks: async ({ saveOrganisation, period }) => { seenPeriod = period; await saveOrganisation(); return { period }; },
});

const ledgers = require('../src/services/ledgers');
const { syncLedgerOrganisation, validYearEnd } = require('../src/services/ledgerSync');
const zoho = require('../src/services/ledgers/zoho');
const { periodMenu } = require('../src/services/periodResolver');

let companyInfo = {};
let fetchOptions = null;
const originalProvider = ledgers.provider;
ledgers.provider = () => ({
  ledger: zoho.ledger,
  fetchCompanyInfo: async () => companyInfo,
  fetchDocuments: async (externalId, options) => { fetchOptions = options; return { invoices: [], bills: [], credits: [], contacts: [] }; },
});
test.after(() => { ledgers.provider = originalProvider; });
test.beforeEach(() => { saved.length = 0; failSave = false; seenPeriod = null; });

test('a January-start Zoho organisation: 31/12 is saved on the client', async () => {
  companyInfo = { name: 'Made Up FZ LLC', baseCurrency: 'AED', ...zoho.financialYearEnd('january') };
  await syncLedgerOrganisation('zoho-600000001', null, { period: { type: 'all_transactions' } });
  assert.deepEqual(saved, [{ orgId: 77, financialYearEndDay: 31, financialYearEndMonth: 12 }]);
});

test('no year end given, an invalid one, or a cache-only run leaves the stored year end alone', async () => {
  for (const info of [{}, { financialYearEndDay: null, financialYearEndMonth: null }, { financialYearEndDay: 31, financialYearEndMonth: 13 },
    { financialYearEndDay: 0, financialYearEndMonth: 3 }, { financialYearEndDay: 31 }, { financialYearEndDay: 'x', financialYearEndMonth: 3 }]) {
    companyInfo = { name: 'Made Up FZ LLC', baseCurrency: 'AED', ...info };
    await syncLedgerOrganisation('zoho-600000001', null, {});
  }
  companyInfo = { name: 'Made Up FZ LLC', ...zoho.financialYearEnd('january') };
  await syncLedgerOrganisation('zoho-600000001', null, { cacheOnly: true });
  assert.deepEqual(saved, []);
  assert.equal(validYearEnd({ financialYearEndDay: '30', financialYearEndMonth: '6' }).financialYearEndMonth, 6);
});

test('a failed save is logged and does not fail the sync', async t => {
  const logged = [];
  t.mock.method(console, 'error', message => logged.push(String(message)));
  failSave = true;
  companyInfo = { name: 'Made Up FZ LLC', ...zoho.financialYearEnd('january') };
  await syncLedgerOrganisation('zoho-600000001', null, {});
  assert.ok(logged.some(line => line.includes('year end not saved')));
});

test('the client page period menu then shows a 31/12 year end', () => {
  // periodContextFor (src/routes/client.js) hands the stored columns to the period menu.
  const clientRoute = fs.readFileSync(path.join(__dirname, '../src/routes/client.js'), 'utf8');
  assert.match(clientRoute, /financialYearEndDay: org\.financial_year_end_day,\s*financialYearEndMonth: org\.financial_year_end_month/);
  const org = { financial_year_end_day: 31, financial_year_end_month: 12 };
  const labels = periodMenu({ asOf: '2026-11-24', financialYearEndDay: org.financial_year_end_day, financialYearEndMonth: org.financial_year_end_month,
    ledgerName: 'Zoho Books' }).map(option => option.label);
  assert.ok(labels.includes('Year Ended 31/12/2026'), labels.join(' | '));
  assert.ok(labels.includes('Year Ended 31/12/2025'));
  assert.ok(!labels.some(label => /Year Ended 31\/03/.test(label)));
});

test('the Xero sync still saves its year end the same way; FreeAgent does not go through this sync', () => {
  const xeroSync = fs.readFileSync(path.join(__dirname, '../src/services/xeroSync.js'), 'utf8');
  assert.match(xeroSync, /updateOrganisationAccountingSettings\(orgId, \{\s*financialYearEndDay: orgInfo\.financialYearEndDay,/);
  assert.equal(ledgers.ledgerOfIdentifier('35963'), null);
});

test('the provider is handed the cached opening balances, so a failed read can keep them', async () => {
  cachedRows = [
    { invoiceID: 'ob-1', type: 'ACCREC', isOpeningBalance: true, contact: { contactID: 'c1' } },
    { invoiceID: 'i1', type: 'ACCREC', contact: { contactID: 'c1' } },
    { invoiceID: 'bill-ob-2', type: 'ACCPAY', isOpeningBalance: true, contact: { contactID: 'c2' } },
  ];
  try {
    companyInfo = { name: 'Made Up FZ LLC', baseCurrency: 'AED' };
    await syncLedgerOrganisation('zoho-600000001', null, {});
    assert.equal(typeof fetchOptions.cachedOpeningBalances, 'function');
    assert.deepEqual((await fetchOptions.cachedOpeningBalances()).map(doc => doc.invoiceID), ['ob-1', 'bill-ob-2']);
  } finally { cachedRows = [{ cached: true }]; }
});
