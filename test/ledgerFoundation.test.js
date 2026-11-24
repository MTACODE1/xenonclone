// The shared foundation for the non-Xero ledgers (FreeAgent, QuickBooks, Zoho Books): telling the
// ledgers apart, sending each sync to the right place, the shared checks every non-Xero ledger runs,
// and the connect/choose/disconnect routes for QuickBooks and Zoho.
// Throwaway SQLite; MySQL is replaced by a small in-memory stand-in; the ledgers' own APIs are fakes.
// Nothing here reaches a real ledger or database. Made-up data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akrio-ledger-foundation-'));
process.env.XERO_DASHBOARD_DB_PATH = path.join(dir, 'test.db');
// With no MySQL user set, the cache store does not try to copy rows to or from MySQL.
delete process.env.AKRIO_DB_USER;

// ---- MySQL stand-in: keeps just enough state (organisations, sync runs) for the code under test ----
const calls = [];
const orgs = new Map(); // freeagent_company_id -> organisation row
let nextOrgId = 2000;
let nextRunId = 5000;
const resetCalls = () => { calls.length = 0; };
const storedCurrency = new Map(); // org id -> currency code
function seedOrg(identifier, id, extra = {}) {
  const row = { id, freeagent_company_id: identifier, xero_tenant_id: null, name: 'Made Up Ltd', client_ref: null, tag: null, connection_status: 'connected', ...extra };
  orgs.set(identifier, row);
  return row;
}
async function fakeQuery(sql, params = []) {
  calls.push({ sql, params });
  if (/WHERE o\.freeagent_company_id = \?/.test(sql)) {
    const row = orgs.get(params[0]);
    return [row ? [{ ...row }] : [], []];
  }
  if (/INSERT INTO akrio_organisations/.test(sql)) {
    const [identifier, name, clientRef, tag, status] = params;
    const existing = orgs.get(identifier);
    if (existing) Object.assign(existing, { name, connection_status: status });
    else seedOrg(identifier, nextOrgId++, { name, client_ref: clientRef, tag, connection_status: status });
    return [{ affectedRows: 1 }, []];
  }
  if (/UPDATE akrio_organisations SET connection_status = 'disconnected' WHERE freeagent_company_id/.test(sql)) {
    const row = orgs.get(params[0]);
    if (row) row.connection_status = 'disconnected';
    return [{ affectedRows: row ? 1 : 0 }, []];
  }
  if (/INSERT INTO akrio_sync_runs/.test(sql)) return [{ insertId: nextRunId++ }, []];
  // akrio_org_currency (orgCurrency.js): one currency per client.
  if (/INSERT INTO akrio_org_currency/.test(sql)) { storedCurrency.set(Number(params[0]), params[1]); return [{ affectedRows: 1 }, []]; }
  if (/SELECT currency_code FROM akrio_org_currency WHERE org_id = \?/.test(sql)) {
    const code = storedCurrency.get(Number(params[0]));
    return [code ? [{ currency_code: code }] : [], []];
  }
  // activateSyncRun asks whether runLedgerChecks staged a health score; upsertHealthScore was called just before.
  if (/SELECT 1 FROM akrio_health_scores/.test(sql)) return [[{ 1: 1 }], []];
  return [{ insertId: 0, affectedRows: 0 }, []];
}
const fakePool = {
  query: fakeQuery,
  getConnection: async () => ({ query: fakeQuery, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} }),
};
const poolPath = require.resolve('../src/db/mysqlPool');
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => fakePool } };

// ---- FreeAgent's API stand-in, so the real freeagentSync can be run end to end ----
const freeagentData = { invoices: [], bills: [], contacts: [], credits: [] };
const adapterPath = require.resolve('../src/services/freeagentAdapter');
require.cache[adapterPath] = {
  id: adapterPath, filename: adapterPath, loaded: true,
  exports: {
    fetchContactsById: async () => new Map(),
    fetchAllInvoices: async () => freeagentData.invoices,
    fetchAllBills: async () => freeagentData.bills,
    fetchAllContacts: async () => freeagentData.contacts,
    fetchAllCreditNotes: async () => freeagentData.credits,
  },
};

const ledgers = require('../src/services/ledgers');
const { runLedgerChecks } = require('../src/services/ledgerChecks');
const { resolvePeriod } = require('../src/services/periodResolver');
const { getDb } = require('../src/db/schema');
const { toMysqlDate } = require('../src/db/ledgerTokens');

// ---- a fake QuickBooks provider ----
// The real src/services/ledgers/quickbooks.js is being written separately and may not exist yet; Node
// will not serve a require.cache entry for a file it cannot find, so the fake is put in require.cache
// (used once the file exists) AND handed out by ledgers.provider (used either way). ledgerSync looks
// the provider up through ledgers.provider at call time, so this is what it gets.
const qbo = {
  ledger: { key: 'quickbooks', purchaseCredits: true, drafts: false, exchangeRates: true },
  isConfigured: () => true,
  externalIdsRead: [],
  info: { name: 'Made Up Ltd', lockDate: null },
  docs: { invoices: [], bills: [], credits: [], contacts: [] },
  failWith: null,
  async fetchCompanyInfo(externalId) { this.externalIdsRead.push(externalId); return this.info; },
  optionsSeen: [],
  async fetchDocuments(externalId, options) {
    this.externalIdsRead.push(externalId);
    this.optionsSeen.push(options);
    if (this.failWith) throw this.failWith;
    return this.docs;
  },
};
const qboPath = path.join(__dirname, '../src/services/ledgers/quickbooks.js');
require.cache[qboPath] = { id: qboPath, filename: qboPath, loaded: true, exports: qbo };
const realProvider = ledgers.provider;
ledgers.provider = key => (key === 'quickbooks' ? qbo : realProvider(key));

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ---- made-up documents, dated against a frozen "today" of 10 Nov 2026 ----
// Ageing is as at the end of the current month (30 Nov), so a document dated 30 Sep is 61 days old
// (old) although only 41 days have passed by "today", and one dated 1 Oct is exactly 60 (not old).
const TODAY = '2026-11-10T12:00:00.000Z';
const contact = (id, name) => ({ contactID: id, name });
const doc = (id, type, status, date, extra = {}) => ({
  invoiceID: id, invoiceNumber: id.toUpperCase(), type, status, date, dueDate: date,
  total: 0, subTotal: 0, amountDue: 0, hasAttachments: false, ...extra,
});
const credit = (id, type, status, date, remaining) => ({
  creditNoteID: id, creditNoteNumber: id.toUpperCase(), type, status, date,
  total: remaining, subTotal: remaining, remainingCredit: remaining, contact: contact('c1', 'Alpha Trading Ltd'),
});
function sampleDocuments() {
  const invoices = [
    doc('inv-old', 'ACCREC', 'AUTHORISED', '2026-09-30', { total: 100, subTotal: 100, amountDue: 100, contact: contact('c1', 'Alpha Trading Ltd') }),
    doc('inv-edge', 'ACCREC', 'AUTHORISED', '2026-10-01', { total: 50, subTotal: 50, amountDue: 50, contact: contact('c1', 'Alpha Trading Ltd') }),
    doc('inv-draft', 'ACCREC', 'DRAFT', '2026-11-01', { total: 70, subTotal: 70, contact: contact('c1', 'Alpha Trading Ltd') }),
  ];
  const bills = [
    doc('bill-draft', 'ACCPAY', 'DRAFT', '2026-11-02', { total: 30, subTotal: 30, contact: contact('c2', 'Beta Supplies') }),
    doc('bill-auth', 'ACCPAY', 'AUTHORISED', '2026-11-03', { total: 40, subTotal: 40, amountDue: 40, contact: contact('c2', 'Beta Supplies') }),
  ];
  const credits = [
    credit('sc-old', 'ACCRECCREDIT', 'AUTHORISED', '2026-09-01', 25),
    credit('pc-old', 'ACCPAYCREDIT', 'AUTHORISED', '2026-09-29', 15),   // 62 days at 30 Nov, 42 by "today"
    credit('pc-edge', 'ACCPAYCREDIT', 'AUTHORISED', '2026-10-01', 5),   // exactly 60 at 30 Nov: not old
    credit('pc-young', 'ACCPAYCREDIT', 'AUTHORISED', '2026-10-20', 7),
  ];
  const contacts = [
    { contactID: 'c1', name: 'Alpha Trading Ltd', contactStatus: 'ACTIVE' },
    { contactID: 'c2', name: 'Beta Supplies', contactStatus: 'ACTIVE' },
  ];
  return { invoices, bills, credits, contacts };
}

const ALL_CHECKS = [
  'contact_defaults', 'duplicate_bills', 'duplicate_contacts', 'duplicate_invoices', 'old_purchase_credits',
  'old_sales_credits', 'old_unpaid_bills', 'old_unpaid_invoices', 'unapproved_bills', 'unapproved_invoices',
  'undocumented_bills',
];
const issuesOf = (orgId, runId) => Object.fromEntries(getDb().prepare(
  'SELECT check_type, count, period_checked, potential_value_gbp, is_active FROM issues WHERE org_id = ? AND run_id = ?'
).all(orgId, runId).map(row => [row.check_type, row]));
// Each finding is stored as its own issue_findings row (issues.detail_json is not kept).
const findingIds = (orgId, runId, checkType) => getDb().prepare(
  'SELECT detail_json FROM issue_findings WHERE org_id = ? AND run_id = ? AND check_type = ? ORDER BY id'
).all(orgId, runId, checkType).map(row => JSON.parse(row.detail_json).id);
const countsOf = (orgId, runId) => getDb().prepare('SELECT * FROM transaction_counts WHERE org_id = ? AND run_id = ?').get(orgId, runId);
const period = () => resolvePeriod({ type: 'all_transactions' }, { asOf: '2026-11-10' });

async function runChecks(t, orgId, runId, ledger) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(TODAY) });
  const { invoices, bills, credits, contacts } = sampleDocuments();
  getDb();
  let saved = 0;
  const result = await runLedgerChecks({
    org: { id: orgId, name: 'Made Up Ltd' }, runId, period: period(),
    invoices: [...invoices, ...bills], contacts, credits, options: {}, ledger,
    saveOrganisation: async () => { saved++; },
  });
  return { result, saved, issues: issuesOf(orgId, runId), counts: countsOf(orgId, runId) };
}

// ===================== telling the ledgers apart =====================
test('ledgerOf tells all four ledgers apart from the organisation row', () => {
  assert.equal(ledgers.ledgerOf({ xero_tenant_id: '0b7c-made-up-tenant', freeagent_company_id: null }), 'xero');
  assert.equal(ledgers.ledgerOf({ xero_tenant_id: null, freeagent_company_id: '35963' }), 'freeagent');
  assert.equal(ledgers.ledgerOf({ xero_tenant_id: null, freeagent_company_id: 'qbo-9130354851' }), 'quickbooks');
  assert.equal(ledgers.ledgerOf({ xero_tenant_id: null, freeagent_company_id: 'zoho-60012345678' }), 'zoho');
  assert.equal(ledgers.ledgerOf(null), null);
  assert.equal(ledgers.ledgerOf({}), null, 'a row with neither id is no ledger at all');
  assert.equal(ledgers.ledgerLabel({ freeagent_company_id: 'zoho-1' }), 'Zoho Books');
  assert.equal(ledgers.ledgerLabel('quickbooks'), 'QuickBooks');
  assert.equal(ledgers.ledgerLabel('freeagent'), 'FreeAgent');
  assert.equal(ledgers.ledgerLabel('xero'), 'Xero');
});

test('ledgerOfIdentifier only recognises the prefixed ledgers; Xero and FreeAgent ids need the row', () => {
  assert.equal(ledgers.ledgerOfIdentifier('qbo-9130354851'), 'quickbooks');
  assert.equal(ledgers.ledgerOfIdentifier('zoho-60012345678'), 'zoho');
  assert.equal(ledgers.ledgerOfIdentifier('35963'), null);
  assert.equal(ledgers.ledgerOfIdentifier('0b7c1d2e-made-up-xero-tenant'), null);
  assert.equal(ledgers.ledgerOfIdentifier(undefined), null);
  assert.equal(ledgers.ledgerOfIdentifier(12345), null);
});

test('identifierFor and externalIdOf round-trip for all four ledgers', () => {
  assert.equal(ledgers.identifierFor('quickbooks', '9130354851'), 'qbo-9130354851');
  assert.equal(ledgers.identifierFor('zoho', '60012345678'), 'zoho-60012345678');
  // Xero and FreeAgent keep their own ids unchanged (no prefix), never "null35963".
  assert.equal(ledgers.identifierFor('freeagent', '35963'), '35963');
  assert.equal(ledgers.identifierFor('xero', '0b7c-made-up-tenant'), '0b7c-made-up-tenant');
  assert.equal(ledgers.externalIdOf('qbo-9130354851'), '9130354851');
  assert.equal(ledgers.externalIdOf('zoho-60012345678'), '60012345678');
  assert.equal(ledgers.externalIdOf('35963'), '35963');
  assert.equal(ledgers.externalIdOf('0b7c-made-up-tenant'), '0b7c-made-up-tenant');
  for (const key of ['xero', 'freeagent', 'quickbooks', 'zoho']) {
    assert.equal(ledgers.externalIdOf(ledgers.identifierFor(key, '42')), '42', `${key} round-trips`);
  }
});

test('syncNonXeroOrganisation sends qbo-/zoho- to the ledger sync and plain ids to FreeAgent', async () => {
  const seen = [];
  const ledgerSyncPath = require.resolve('../src/services/ledgerSync');
  const freeagentSyncPath = require.resolve('../src/services/freeagentSync');
  const saved = { ledger: require.cache[ledgerSyncPath], freeagent: require.cache[freeagentSyncPath] };
  require.cache[ledgerSyncPath] = { id: ledgerSyncPath, filename: ledgerSyncPath, loaded: true,
    exports: { syncLedgerOrganisation: async (id, progress, options) => { seen.push(['ledger', id, options]); return 'ledger'; } } };
  require.cache[freeagentSyncPath] = { id: freeagentSyncPath, filename: freeagentSyncPath, loaded: true,
    exports: { syncFreeAgentOrganisation: async (id, progress, options) => { seen.push(['freeagent', id, options]); return 'freeagent'; } } };
  try {
    assert.equal(await ledgers.syncNonXeroOrganisation('qbo-9130', null, { cacheOnly: true }), 'ledger');
    assert.equal(await ledgers.syncNonXeroOrganisation('zoho-6001', null), 'ledger');
    assert.equal(await ledgers.syncNonXeroOrganisation('35963', null, { period: { type: 'current_month' } }), 'freeagent');
    assert.deepEqual(seen, [
      ['ledger', 'qbo-9130', { cacheOnly: true }],
      ['ledger', 'zoho-6001', {}],
      ['freeagent', '35963', { period: { type: 'current_month' } }],
    ]);
  } finally {
    // Put the real modules back (or let them load fresh) for the tests below.
    if (saved.ledger) require.cache[ledgerSyncPath] = saved.ledger; else delete require.cache[ledgerSyncPath];
    if (saved.freeagent) require.cache[freeagentSyncPath] = saved.freeagent; else delete require.cache[freeagentSyncPath];
  }
});

// ===================== the shared checks =====================
test('FreeAgent: no supplier credits or default account codes, so those two are not applicable; the rest are worked out', async t => {
  const { issues, saved, result } = await runChecks(t, 901, 9101, { key: 'freeagent', purchaseCredits: false, drafts: true });
  assert.deepEqual(Object.keys(issues).sort(), ALL_CHECKS, 'every check has a result row');
  assert.equal(issues.old_purchase_credits.period_checked, 'not_applicable_freeagent');
  assert.equal(issues.old_purchase_credits.count, 0);
  assert.equal(issues.contact_defaults.period_checked, 'not_applicable_freeagent');
  for (const type of ALL_CHECKS.filter(c => !['old_purchase_credits', 'contact_defaults'].includes(c))) {
    assert.doesNotMatch(issues[type].period_checked, /^not_applicable/, `${type} is worked out`);
  }
  assert.equal(issues.unapproved_invoices.count, 1, 'FreeAgent has drafts');
  assert.equal(issues.unapproved_bills.count, 1);
  assert.equal(issues.old_sales_credits.count, 1);
  assert.equal(issues.undocumented_bills.count, 1);
  assert.equal(issues.old_unpaid_bills.count, 0);
  assert.equal(saved, 1, 'the organisation is saved once');
  assert.equal(typeof result.score, 'number');
  assert.ok(Object.values(issues).every(row => row.is_active === 1), 'the run was activated');
});

test('QuickBooks: no drafts, so unapproved_* are not applicable; old supplier credits are worked out from ACCPAYCREDIT over 60 days', async t => {
  const { issues } = await runChecks(t, 902, 9102, { key: 'quickbooks', purchaseCredits: true, drafts: false });
  assert.deepEqual(Object.keys(issues).sort(), ALL_CHECKS);
  assert.equal(issues.unapproved_invoices.period_checked, 'not_applicable_quickbooks');
  assert.equal(issues.unapproved_bills.period_checked, 'not_applicable_quickbooks');
  assert.equal(issues.unapproved_invoices.count, 0);
  assert.equal(issues.contact_defaults.period_checked, 'not_applicable_quickbooks');
  assert.doesNotMatch(issues.old_purchase_credits.period_checked, /^not_applicable/);
  assert.deepEqual(findingIds(902, 9102, 'old_purchase_credits'), ['pc-old'], 'only the supplier credit over 60 days; the sales credit is not counted here');
  assert.equal(issues.old_purchase_credits.count, 1);
  assert.equal(issues.old_purchase_credits.potential_value_gbp, 15);
});

test('ageing is as at the end of the current month, not today', async t => {
  const { issues } = await runChecks(t, 903, 9103, { key: 'zoho', purchaseCredits: true, drafts: true });
  const oldInvoices = findingIds(903, 9103, 'old_unpaid_invoices');
  // 30 Sep is 41 days before "today" (10 Nov) but 61 before 30 Nov: old. 1 Oct is exactly 60: not old.
  assert.deepEqual(oldInvoices, ['inv-old']);
  assert.equal(issues.old_unpaid_invoices.potential_value_gbp, 100);
  assert.deepEqual(findingIds(903, 9103, 'old_purchase_credits'), ['pc-old']);
  assert.deepEqual(findingIds(903, 9103, 'old_sales_credits'), ['sc-old']);
});

// A document in another currency keeps its own figures on its row, which says which currency it is in
// (the conversion itself is tested in foreignCurrencyConversion.test.js; these documents carry no rate,
// so they are marked as having none); a row in the client's own currency is left exactly as it was.
test('a document in another currency is marked with that currency on its check row', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(TODAY) });
  const { invoices, bills, credits, contacts } = sampleDocuments();
  invoices[0].currencyCode = 'USD';
  credits[0].currencyCode = 'AED';
  bills[0].currencyCode = 'EUR';
  getDb();
  await runLedgerChecks({
    org: { id: 908, name: 'Made Up Ltd' }, runId: 9108, period: period(),
    invoices: [...invoices, ...bills], contacts, credits, options: {}, ledger: { key: 'zoho', purchaseCredits: true, drafts: true, exchangeRates: true },
    saveOrganisation: async () => {}, baseCurrency: 'AED',
  });
  const rows = checkType => getDb().prepare(
    'SELECT detail_json FROM issue_findings WHERE org_id = ? AND run_id = ? AND check_type = ? ORDER BY id'
  ).all(908, 9108, checkType).map(row => JSON.parse(row.detail_json));
  assert.equal(rows('old_unpaid_invoices')[0].currency, 'USD');
  assert.equal(rows('unapproved_bills').find(row => row.id === 'bill-draft').currency, 'EUR');
  assert.ok(!('currency' in rows('old_sales_credits')[0]), 'a document in the client\'s own currency gets no field');
  assert.ok(!('currency' in rows('old_purchase_credits')[0]), 'no currency on the document: no field');
});

test('transaction counts include purchase credit notes', async t => {
  const { counts } = await runChecks(t, 904, 9104, { key: 'quickbooks', purchaseCredits: true, drafts: false });
  assert.ok(counts, 'a transaction_counts row is written for the run');
  assert.equal(counts.customer_invoices, 2);
  assert.equal(counts.supplier_bills, 1);
  assert.equal(counts.credit_notes_sales, 1);
  assert.equal(counts.credit_notes_purchase, 3);
  assert.equal(counts.total_transactions, 2 + 1 + 1 + 3);
  assert.equal(counts.turnover, 100 + 50 - 25, 'sales credit notes are netted off; supplier credits are not');
  assert.equal(counts.is_active, 1);
});

test('turnover is "not available" (null), not £0, when the ledger gives no net amounts (Zoho lists)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(TODAY) });
  const { invoices, bills, credits, contacts } = sampleDocuments();
  getDb();
  await runLedgerChecks({
    org: { id: 905, name: 'Made Up Ltd' }, runId: 9105, period: period(),
    invoices: [...invoices.map(i => ({ ...i, subTotal: null })), ...bills], contacts, credits, options: {},
    ledger: { key: 'zoho', purchaseCredits: true, drafts: true }, saveOrganisation: async () => {}, lockDate: '2025-03-31',
  });
  const counts = countsOf(905, 9105);
  assert.equal(counts.turnover, null);
  assert.equal(counts.customer_invoices, 2, 'the counts are still there');
});

// ===================== the syncs that call the shared checks =====================
test('the FreeAgent sync now runs the shared checks as FreeAgent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(TODAY) });
  const docs = sampleDocuments();
  Object.assign(freeagentData, {
    invoices: docs.invoices, bills: docs.bills, contacts: docs.contacts,
    credits: docs.credits.filter(c => c.type === 'ACCRECCREDIT'), // FreeAgent's credit notes are sales-side only
  });
  seedOrg('35963', 905);
  resetCalls();
  const { syncFreeAgentOrganisation } = require('../src/services/freeagentSync');
  const result = await syncFreeAgentOrganisation('35963', null, { period: { type: 'all_transactions' }, asOf: '2026-11-10' });
  assert.ok(calls.some(c => /INSERT INTO akrio_sync_runs/.test(c.sql)), 'a sync run is created');
  const runId = nextRunId - 1;
  const issues = issuesOf(905, runId);
  assert.deepEqual(Object.keys(issues).sort(), ALL_CHECKS);
  assert.equal(issues.old_purchase_credits.period_checked, 'not_applicable_freeagent');
  assert.equal(issues.contact_defaults.period_checked, 'not_applicable_freeagent');
  assert.equal(issues.unapproved_invoices.count, 1);
  assert.deepEqual(findingIds(905, runId, 'old_unpaid_invoices'), ['inv-old']);
  assert.equal(typeof result.score, 'number');
  const upsert = calls.find(c => /INSERT INTO akrio_organisations/.test(c.sql));
  assert.equal(upsert.params[0], '35963', 'the FreeAgent organisation row is saved under its own id');
});

test('a QuickBooks sync reads through the provider with the bare realm id and runs the shared checks as QuickBooks', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(TODAY) });
  seedOrg('qbo-9130', 906);
  qbo.docs = sampleDocuments();
  qbo.externalIdsRead = [];
  qbo.failWith = null;
  resetCalls();
  const { syncLedgerOrganisation } = require('../src/services/ledgerSync');
  const progress = [];
  await syncLedgerOrganisation('qbo-9130', p => progress.push(p.step), { period: { type: 'all_transactions' }, asOf: '2026-11-10' });
  assert.deepEqual(qbo.externalIdsRead, ['9130', '9130']);
  const issues = issuesOf(906, nextRunId - 1);
  assert.deepEqual(Object.keys(issues).sort(), ALL_CHECKS);
  assert.equal(issues.unapproved_bills.period_checked, 'not_applicable_quickbooks');
  assert.equal(issues.old_purchase_credits.count, 1);
  assert.equal(countsOf(906, nextRunId - 1).credit_notes_purchase, 3);
  assert.ok(progress.includes('done'));
  const upsert = calls.find(c => /INSERT INTO akrio_organisations/.test(c.sql));
  assert.equal(upsert.params[0], 'qbo-9130');
  await assert.rejects(syncLedgerOrganisation('35963'), /Not a QuickBooks or Zoho client/);
});

test('a QuickBooks sign-in that is no longer accepted fails the run and marks the client disconnected', async () => {
  seedOrg('qbo-7777', 907);
  qbo.failWith = new Error('invalid_grant: refresh token expired');
  resetCalls();
  const { syncLedgerOrganisation } = require('../src/services/ledgerSync');
  try {
    await assert.rejects(syncLedgerOrganisation('qbo-7777', null, {}), /invalid_grant/);
  } finally {
    qbo.failWith = null;
  }
  assert.ok(calls.some(c => /UPDATE akrio_sync_runs SET status = \?/.test(c.sql) && c.params[0] === 'failed'));
  assert.equal(orgs.get('qbo-7777').connection_status, 'disconnected');
  // Any other failure leaves the connection alone.
  seedOrg('qbo-8888', 908);
  qbo.failWith = new Error('QuickBooks is having a bad day');
  try {
    await assert.rejects(syncLedgerOrganisation('qbo-8888', null, {}), /bad day/);
  } finally {
    qbo.failWith = null;
  }
  assert.equal(orgs.get('qbo-8888').connection_status, 'connected');
});

// The sync hands the organisation's currency to the provider (Zoho reads vendor credit rates by it), keeps each
// document's currencyRate through the cache, and a cache-only re-run gives the same converted totals. Before the
// client's currency is stored, a cache-only re-run leaves the totals as they were rather than zeroing them.
test('ledger sync: the organisation currency reaches fetchDocuments, and cache-only re-runs keep the converted totals', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(TODAY) });
  const { syncLedgerOrganisation } = require('../src/services/ledgerSync');
  const savedInfo = qbo.info;
  const savedDocs = qbo.docs;
  t.after(() => { qbo.info = savedInfo; qbo.docs = savedDocs; });
  const options = { period: { type: 'all_transactions' }, asOf: '2026-11-10' };
  const oldInvoice = (id, amount, extra) => doc(id, 'ACCREC', 'AUTHORISED', '2026-09-01',
    { total: amount, subTotal: amount, amountDue: amount, contact: contact('c1', 'Alpha Trading Ltd'), ...extra });
  const oldUnpaid = orgId => issuesOf(orgId, nextRunId - 1).old_unpaid_invoices.potential_value_gbp;

  // A GBP client with a EUR invoice (EUR 100 at 1.25 EUR per GBP = 80.00) and a GBP one (50.00): 130.00.
  seedOrg('qbo-4242', 910);
  qbo.info = { name: 'Made Up Ltd', lockDate: null, baseCurrency: 'GBP' };
  qbo.docs = { invoices: [oldInvoice('fx-eur', 100, { currencyCode: 'EUR', currencyRate: 1.25 }), oldInvoice('fx-gbp', 50, { currencyCode: 'GBP' })],
    bills: [], credits: [credit('fx-cn', 'ACCRECCREDIT', 'AUTHORISED', '2026-11-01', 1)], contacts: [{ contactID: 'c1', name: 'Alpha Trading Ltd', contactStatus: 'ACTIVE' }] };
  qbo.optionsSeen = [];
  await syncLedgerOrganisation('qbo-4242', null, options);
  assert.equal(qbo.optionsSeen.at(-1).baseCurrency, 'GBP', 'fetchDocuments is told the organisation currency');
  assert.equal(oldUnpaid(910), 130);
  assert.equal(storedCurrency.get(910), 'GBP');
  qbo.optionsSeen = [];
  await syncLedgerOrganisation('qbo-4242', null, { ...options, cacheOnly: true });
  assert.equal(qbo.optionsSeen.length, 0, 'a cache-only run reads nothing from the ledger');
  assert.equal(oldUnpaid(910), 130, 'the same converted total from the cache');
  const cached = getDb().prepare('SELECT json FROM xero_entity_cache WHERE org_id = ? AND entity_type = ?').all(910, 'invoice')
    .map(row => JSON.parse(row.json)).find(row => row.invoiceID === 'fx-eur');
  assert.equal(cached.currencyRate, 1.25, 'currencyRate survives the cache');

  // An AED client cached before its currency was stored: AED 500, documents with no rate. A cache-only run with no
  // stored currency must not treat AED as foreign (that zeroed the total); it stays 500.
  seedOrg('qbo-4343', 911);
  qbo.info = { name: 'Made Up FZ LLC', lockDate: null, baseCurrency: 'AED' };
  qbo.docs = { invoices: [oldInvoice('aed-1', 500, { currencyCode: 'AED' })], bills: [],
    credits: [credit('aed-cn', 'ACCRECCREDIT', 'AUTHORISED', '2026-11-01', 1)], contacts: [{ contactID: 'c1', name: 'Alpha Trading Ltd', contactStatus: 'ACTIVE' }] };
  await syncLedgerOrganisation('qbo-4343', null, options);
  assert.equal(oldUnpaid(911), 500);
  storedCurrency.delete(911);
  await syncLedgerOrganisation('qbo-4343', null, { ...options, cacheOnly: true });
  assert.equal(oldUnpaid(911), 500, 'not 0');
});

// ===================== sign-in tokens =====================
test('toMysqlDate turns dates into MySQL DATETIME text and anything unreadable into null', () => {
  assert.equal(toMysqlDate('2026-11-10T12:34:56.000Z'), '2026-11-10 12:34:56');
  assert.equal(toMysqlDate(new Date('2026-01-02T03:04:05Z')), '2026-01-02 03:04:05');
  assert.equal(toMysqlDate(null), null);
  assert.equal(toMysqlDate(''), null);
  assert.equal(toMysqlDate('not a date'), null);
});

// ===================== connect, choose and disconnect routes =====================
const express = require('express');
const { createLedgerAuthRouter } = require('../src/routes/ledgerAuth');

const session = {};
const authFakes = {
  quickbooks: {
    isConfigured: () => true,
    buildConsentUrl: state => `https://consent.example.test/authorize?state=${state}`,
    completeCalls: 0,
    async completeConnection(query) {
      this.completeCalls++;
      return [{ externalId: '9130', name: 'Made Up Ltd', token: { access_token: 'made-up-access', refresh_token: 'made-up-refresh', expires_at: '2026-11-10T13:00:00Z' } }];
    },
  },
  zoho: {
    isConfigured: () => true,
    buildConsentUrl: state => `https://consent.example.test/zoho?state=${state}`,
    async completeConnection() {
      return [
        { externalId: '6001', name: '<script>alert(1)</script> Alpha & Co', token: { access_token: 'a1', refresh_token: 'r1', api_domain: 'https://books.example.test' } },
        { externalId: '6002', name: 'Beta "Quoted" Ltd', token: { access_token: 'a2', refresh_token: 'r2' } },
        { externalId: '6003', name: 'Gamma Ltd', token: { access_token: 'a3', refresh_token: 'r3' } },
      ];
    },
  },
};
let baseUrl;
let server;
test.before(async () => {
  const app = express();
  app.use((req, res, next) => { req.session = session; res.locals.basePath = ''; next(); });
  app.use('/auth/quickbooks', createLedgerAuthRouter('quickbooks', { providerModule: authFakes.quickbooks }));
  app.use('/auth/zoho', createLedgerAuthRouter('zoho', { providerModule: authFakes.zoho }));
  app.use('/auth/unset', createLedgerAuthRouter('quickbooks', { providerModule: { isConfigured: () => false } }));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

const get = route => fetch(baseUrl + route, { redirect: 'manual' });
const post = (route, fields) => fetch(baseUrl + route, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});
const clearSession = () => { for (const key of Object.keys(session)) delete session[key]; };

test('/connect answers 503 when the ledger has no app keys yet', async () => {
  const res = await get('/auth/unset/connect');
  assert.equal(res.status, 503);
  assert.match(await res.text(), /QuickBooks is not set up/);
});

test('/connect saves a random state on the session and redirects to the ledger with it', async () => {
  clearSession();
  const res = await get('/auth/quickbooks/connect');
  assert.equal(res.status, 302);
  assert.match(session.quickbooksOauthState, /^[0-9a-f]{32}$/);
  assert.equal(res.headers.get('location'), `https://consent.example.test/authorize?state=${session.quickbooksOauthState}`);
});

test('/callback refuses a state that is not the one saved on the session', async () => {
  clearSession();
  session.quickbooksOauthState = 'a'.repeat(32);
  authFakes.quickbooks.completeCalls = 0;
  resetCalls();
  const res = await get(`/auth/quickbooks/callback?state=${'b'.repeat(32)}&code=x&realmId=9130`);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Invalid or expired QuickBooks sign-in link/);
  assert.equal(authFakes.quickbooks.completeCalls, 0, 'no token is asked for');
  assert.equal(calls.length, 0, 'nothing is written');
  const none = await get('/auth/quickbooks/callback?code=x');
  assert.equal(none.status, 400, 'no state at all is refused too');
});

test('/callback with one company saves its token, adds the client and returns to the client list', async () => {
  clearSession();
  session.quickbooksOauthState = 'c'.repeat(32);
  session.staffRole = 'staff';
  session.staffId = 7;
  resetCalls();
  const res = await get(`/auth/quickbooks/callback?state=${'c'.repeat(32)}&code=x&realmId=9130`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  assert.equal(session.quickbooksOauthState, undefined, 'the state is used once');
  const token = calls.find(c => /INSERT INTO akrio_ledger_tokens/.test(c.sql));
  assert.deepEqual(token.params.slice(0, 5), ['quickbooks', '9130', 'made-up-access', 'made-up-refresh', '2026-11-10 13:00:00']);
  const org = calls.find(c => /INSERT INTO akrio_organisations/.test(c.sql));
  assert.equal(org.params[0], 'qbo-9130');
  assert.equal(org.params[4], 'connected');
  // A staff-tier user who connects a client is given access to it.
  const access = calls.find(c => /INSERT IGNORE INTO akrio_staff_org_access/.test(c.sql));
  assert.deepEqual(access.params, [7, orgs.get('qbo-9130').id]);
});

test('/callback with several organisations goes to /choose, which lists them HTML-escaped', async () => {
  clearSession();
  session.zohoOauthState = 'd'.repeat(32);
  session.staffRole = 'admin';
  session.csrfToken = 'made-up-csrf';
  resetCalls();
  const res = await get(`/auth/zoho/callback?state=${'d'.repeat(32)}&code=x`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/auth/zoho/choose');
  assert.equal(session.zohoPendingCompanies.companies.length, 3);
  assert.equal(calls.filter(c => /INSERT INTO/.test(c.sql)).length, 0, 'nothing is connected before the staff member picks');
  const page = await (await get('/auth/zoho/choose')).text();
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Alpha &amp; Co/);
  assert.doesNotMatch(page, /<script>alert/);
  assert.match(page, /Beta &quot;Quoted&quot; Ltd/);
  assert.match(page, /value="6001"/);
  assert.match(page, /value="6003"/);
  assert.match(page, /name="csrf_token" value="made-up-csrf"/);
});

test('POST /choose needs the form token, then connects only the ticked organisations', async () => {
  // Carries on from the session left by the test above.
  resetCalls();
  const refused = await post('/auth/zoho/choose', { externalId: '6001' });
  assert.equal(refused.status, 403);
  const wrong = await post('/auth/zoho/choose', { csrf_token: 'not-it', externalId: '6001' });
  assert.equal(wrong.status, 403);
  assert.equal(calls.length, 0, 'nothing is written without the right token');

  const body = new URLSearchParams([['csrf_token', 'made-up-csrf'], ['externalId', '6001'], ['externalId', '6003']]);
  const res = await fetch(baseUrl + '/auth/zoho/choose', {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  const tokens = calls.filter(c => /INSERT INTO akrio_ledger_tokens/.test(c.sql)).map(c => c.params.slice(0, 2));
  assert.deepEqual(tokens, [['zoho', '6001'], ['zoho', '6003']]);
  const added = calls.filter(c => /INSERT INTO akrio_organisations/.test(c.sql)).map(c => c.params[0]);
  assert.deepEqual(added, ['zoho-6001', 'zoho-6003']);
  assert.equal(session.zohoPendingCompanies, undefined, 'the pending list is cleared');
  assert.equal(calls.filter(c => /akrio_staff_org_access/.test(c.sql)).length, 0, 'a manager already sees every client');

  const again = await post('/auth/zoho/choose', { csrf_token: 'made-up-csrf', externalId: '6002' });
  assert.equal(again.status, 400, 'the list can be used once');
});

test('disconnect needs the form token, then marks the client disconnected and removes its token', async () => {
  clearSession();
  session.csrfToken = 'made-up-csrf';
  resetCalls();
  const refused = await post('/auth/quickbooks/disconnect/9130', {});
  assert.equal(refused.status, 403);
  assert.equal(calls.length, 0);
  // A staff-tier user without access to this client may not disconnect it (review, 24 Nov 2026).
  session.staffRole = 'staff'; session.staffId = 77;
  const noAccess = await post('/auth/quickbooks/disconnect/9130', { csrf_token: 'made-up-csrf' });
  assert.equal(noAccess.status, 403);
  assert.ok(!calls.some(c => /disconnected|DELETE FROM akrio_ledger_tokens/.test(c.sql)), 'nothing was changed');
  session.staffRole = 'admin';
  const res = await post('/auth/quickbooks/disconnect/9130', { csrf_token: 'made-up-csrf' });
  assert.equal(res.status, 302);
  const update = calls.find(c => /SET connection_status = 'disconnected' WHERE freeagent_company_id/.test(c.sql));
  assert.deepEqual(update.params, ['qbo-9130']);
  const removed = calls.find(c => /DELETE FROM akrio_ledger_tokens/.test(c.sql));
  assert.deepEqual(removed.params, ['quickbooks', '9130']);
  assert.equal(orgs.get('qbo-9130').connection_status, 'disconnected');
});

// ===================== 25 Nov 2026: the non-Xero rules brought into line with Xero =====================
const findingRows = (orgId, runId, checkType) => getDb().prepare(
  'SELECT detail_json FROM issue_findings WHERE org_id = ? AND run_id = ? AND check_type = ? ORDER BY id'
).all(orgId, runId, checkType).map(row => JSON.parse(row.detail_json));
async function runWith(t, orgId, runId, ledger, { invoices = [], contacts = [], baseCurrency = null } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(TODAY) });
  getDb();
  await runLedgerChecks({
    org: { id: orgId, name: 'Made Up Ltd' }, runId, period: period(), invoices, contacts, credits: [], options: {}, ledger,
    baseCurrency, saveOrganisation: async () => {},
  });
  return issuesOf(orgId, runId);
}

test('Old Unpaid Invoices (non-Xero ledgers): aged by DUE date as at the end of the month, the invoice date only when there is no due date', async t => {
  const c1 = contact('c1', 'Alpha Trading Ltd');
  const invoices = [
    doc('long-terms', 'ACCREC', 'AUTHORISED', '2026-07-01', { dueDate: '2026-10-15', amountDue: 100, total: 100, contact: c1 }), // old by date, not by due date
    doc('overdue', 'ACCREC', 'AUTHORISED', '2026-09-01', { dueDate: '2026-09-15', amountDue: 60, total: 60, contact: c1 }),     // 76 days past due at 30 Nov
    doc('no-due', 'ACCREC', 'AUTHORISED', '2026-09-29', { dueDate: null, amountDue: 30, total: 30, contact: c1 }),             // no due date: 62 days from its date
    doc('paid', 'ACCREC', 'PAID', '2026-01-01', { dueDate: '2026-01-31', amountDue: 0, total: 10, contact: c1 }),
  ];
  for (const [key, orgId, runId] of [['zoho', 911, 9111], ['quickbooks', 912, 9112], ['freeagent', 913, 9113]]) {
    const issues = await runWith(t, orgId, runId, { key, purchaseCredits: true, drafts: true }, { invoices });
    assert.deepEqual(findingIds(orgId, runId, 'old_unpaid_invoices').sort(), ['no-due', 'overdue'], key);
    assert.equal(issues.old_unpaid_invoices.potential_value_gbp, 90, key);
    t.mock.timers.reset();
  }
});

test('Undocumented Bills (Zoho): paid bills with no attachment are included, as the Xero rule; the other ledgers keep unpaid only', async t => {
  const c2 = contact('c2', 'Beta Supplies');
  const invoices = [
    doc('b-paid', 'ACCPAY', 'PAID', '2026-08-01', { total: 50, contact: c2 }),
    doc('b-open', 'ACCPAY', 'AUTHORISED', '2026-08-02', { total: 40, amountDue: 40, contact: c2 }),
    doc('b-doc', 'ACCPAY', 'PAID', '2026-08-03', { total: 30, contact: c2, hasAttachments: true }),
    doc('b-ob', 'ACCPAY', 'PAID', '2026-08-04', { total: 20, contact: c2, isOpeningBalance: true }),
  ];
  const zohoIssues = await runWith(t, 914, 9114, { key: 'zoho', purchaseCredits: true, drafts: true }, { invoices });
  assert.deepEqual(findingRows(914, 9114, 'undocumented_bills').map(r => r.invoiceId).sort(), ['b-open', 'b-paid']);
  assert.equal(zohoIssues.undocumented_bills.count, 2);
  t.mock.timers.reset();
  await runWith(t, 915, 9115, { key: 'quickbooks', purchaseCredits: true, drafts: false }, { invoices });
  assert.deepEqual(findingRows(915, 9115, 'undocumented_bills').map(r => r.invoiceId), ['b-open']);
});

test('Duplicate Contacts (UAE Zoho client): UAE legal endings and Dr/Cr copies are ignored; the pairs show the real names', async t => {
  const names = [['k1', 'Blue Sea FZE'], ['k2', 'Blue Sea FZ-LLC'], ['k3', 'Nova Tech DMCC'], ['k4', 'NOVA TECH FZCO'],
    ['k5', 'Desert Rose (Sole Proprietorship L.L.C.)'], ['k6', 'Desert Rose Trading LLC S.P.S'], ['k7', 'Acme Supplies Dr.'], ['k8', 'Acme Supplies (Cr)'],
    ['k9', 'Unrelated Works']];
  const contacts = names.map(([id, name]) => ({ contactID: id, name, contactStatus: 'ACTIVE' }));
  const invoices = names.map(([id, name], index) => doc(`d-${id}`, 'ACCPAY', 'AUTHORISED', '2026-08-01', { total: 10 + index, amountDue: 10 + index, contact: contact(id, name), hasAttachments: true }));
  const pairs = orgId => findingRows(orgId, orgId * 10, 'duplicate_contacts').map(r => [r.name1, r.name2]);
  await runWith(t, 916, 9160, { key: 'zoho', purchaseCredits: true, drafts: true }, { invoices, contacts, baseCurrency: 'AED' });
  assert.deepEqual(pairs(916), [
    ['Blue Sea FZE', 'Blue Sea FZ-LLC'], ['Nova Tech DMCC', 'NOVA TECH FZCO'],
    ['Desert Rose (Sole Proprietorship L.L.C.)', 'Desert Rose Trading LLC S.P.S'], ['Acme Supplies Dr.', 'Acme Supplies (Cr)'],
  ]);
  // Sister companies sharing a group name are not duplicates once their activity words ("General Trading",
  // "Trading", "Est") are dropped; the same business with and without them still is.
  const sisters = [['s1', 'Made Up Star General Trading L.L.C'], ['s2', 'Made Up Star Technical Services LLC'], ['s3', 'Made Up Noor Trading LLC'],
    ['s4', 'Made Up Noor Building Contracting LLC'], ['s5', 'Rubyx Est.'], ['s6', 'Rubyx Electrical Est.'], ['s7', 'MADE UP STAR LLC'],
    ['s8', 'Made Up Noor General Trading'], ['s9', 'Made Up Furniture IND L.L.C'], ['s10', 'Made up furniture']];
  const sisterContacts = sisters.map(([id, name]) => ({ contactID: id, name, contactStatus: 'ACTIVE' }));
  const sisterInvoices = sisters.map(([id, name], index) => doc(`d-${id}`, 'ACCPAY', 'AUTHORISED', '2026-08-01', { total: 10 + index, amountDue: 10 + index, contact: contact(id, name), hasAttachments: true }));
  t.mock.timers.reset();
  await runWith(t, 918, 9180, { key: 'zoho', purchaseCredits: true, drafts: true }, { invoices: sisterInvoices, contacts: sisterContacts, baseCurrency: 'AED' });
  // ("Made Up Star Technical Services LLC" / "MADE UP STAR LLC" is the shared one-name-plus-extra-words rule on the
  // names as they are, found for every ledger; the two sister companies are not paired with each other.)
  assert.deepEqual(pairs(918), [
    ['Made Up Star General Trading L.L.C', 'MADE UP STAR LLC'], ['Made Up Star Technical Services LLC', 'MADE UP STAR LLC'],
    ['Made Up Noor Trading LLC', 'Made Up Noor General Trading'],
    ['Made Up Furniture IND L.L.C', 'Made up furniture'],
  ]);
  // A GBP (UK) Zoho client and every other ledger compare names exactly as before.
  t.mock.timers.reset();
  await runWith(t, 917, 9170, { key: 'zoho', purchaseCredits: true, drafts: true }, { invoices, contacts, baseCurrency: 'GBP' });
  assert.ok(!pairs(917).some(([a]) => a === 'Nova Tech DMCC'), 'UK client: the UAE endings are not stripped');
});
