// runLedgerChecks end to end for a Zoho Books UAE client: the Zoho checks are stored with the rest, the tax profile
// is saved and read back on a cache-only run, the Banking page reading is used, and a ledger with no accounting data
// (QuickBooks, older callers) gets exactly the checks it got before. Throwaway SQLite; MySQL is a stand-in that keeps
// the two Zoho tables in memory. Nothing reaches a real ledger or database. Made-up data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akrio-zoho-checks-'));
process.env.XERO_DASHBOARD_DB_PATH = path.join(dir, 'test.db');
delete process.env.AKRIO_DB_USER;

const profiles = new Map();
let reading = null;
const fakeQuery = async (sql, params = []) => {
  if (/SELECT 1 FROM akrio_health_scores/.test(sql)) return [[{ 1: 1 }], []];
  if (/^INSERT INTO akrio_zoho_tax_profile/.test(sql)) { profiles.set(params[0], { region: params[1], profile_json: params[2] }); return [{ affectedRows: 1 }, []]; }
  if (/FROM akrio_zoho_tax_profile WHERE org_id/.test(sql)) return [profiles.has(params[0]) ? [profiles.get(params[0])] : [], []];
  if (/FROM akrio_zoho_bank_screen_batches WHERE org_id/.test(sql)) {
    return [reading ? [{ id: 1, zoho_org_id: '600000001', books_host: 'books.zoho.com', page_title: 'Banking', summary_total: 3, read_by_name: 'Staff', read_at_unix: reading.readAtUnix }] : [], []];
  }
  if (/FROM akrio_zoho_bank_screen_accounts WHERE batch_id/.test(sql)) return [reading ? reading.rows : [], []];
  return [{ insertId: 0, affectedRows: 0 }, []];
};
const fakePool = {
  query: fakeQuery,
  getConnection: async () => ({ query: fakeQuery, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} }),
};
const poolPath = require.resolve('../src/db/mysqlPool');
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => fakePool } };

const { runLedgerChecks } = require('../src/services/ledgerChecks');
const { resolvePeriod } = require('../src/services/periodResolver');
const { getDb } = require('../src/db/schema');
const zoho = require('../src/services/ledgers/zoho');
const mapping = require('../src/services/ledgers/zoho/mapping');
const qbo = require('../src/services/ledgers/quickbooks');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const TODAY = '2026-11-10T12:00:00.000Z';
const period = () => resolvePeriod({ type: 'since_lock_date' }, { lockDate: '2026-06-30', asOf: '2026-11-10', ledgerName: 'Zoho Books' });
const issuesOf = (orgId, runId) => Object.fromEntries(getDb().prepare(
  'SELECT check_type, count, potential_value_gbp, period_checked FROM issues WHERE org_id = ? AND run_id = ?'
).all(orgId, runId).map(row => [row.check_type, row]));

const accounts = mapping.mergeBankAccounts([
  ['a-bank', 'Main Bank Account', 'bank'], ['a-sales', 'Sales', 'income'], ['a-office', 'Office Supplies', 'expense'],
  ['a-input', 'Input VAT', 'other_current_asset'], ['a-suspense', 'Suspense', 'other_current_liability'],
].map(([id, name, type]) => mapping.mapAccount({ account_id: id, account_name: name, account_type: type, is_active: true })), []);
const taxRates = [mapping.mapTaxRate({ tax_id: 't-std', tax_name: 'Standard Rate', tax_percentage: 5, country_code: 'AE', tax_authority_name: 'FTA' })];
const billRaw = { bill_id: 'b1', bill_number: 'B-1', status: 'paid', date: '2026-08-01', due_date: '2026-08-01', total: 100, balance: 0,
  vendor_id: 'v1', vendor_name: 'Supplier One', currency_code: 'AED', exchange_rate: 1, has_attachment: true, sub_total: 100 };
const bill = { ...zoho.mapBill(billRaw), ...mapping.documentDetail({ ...billRaw, line_items: [{ line_item_id: 'l1', account_id: 'a-office', item_total: 100, tax_id: '' }] }) };
const journal = mapping.mapManualJournal({ journal_id: 'j1', entry_number: 'MJ-1', journal_date: '2026-08-02', status: 'published', line_items: [
  { line_id: 'x1', account_id: 'a-input', debit_or_credit: 'debit', amount: 10, bcy_amount: 10 },
  { line_id: 'x2', account_id: 'a-suspense', debit_or_credit: 'credit', amount: 10, bcy_amount: 10 },
] });
const accounting = { accounts, taxRates, manualJournals: [journal], bankTransactions: [], readStatus: { permissions: { banking: false, expenses: false } } };
const contacts = [{ contactID: 'v1', name: 'Supplier One', contactStatus: 'ACTIVE' }];

async function run(t, orgId, runId, extra = {}) {
  if (!t.__timers) { t.mock.timers.enable({ apis: ['Date'], now: new Date(TODAY) }); t.__timers = true; }
  getDb();
  return runLedgerChecks({
    org: { id: orgId, name: 'Made Up FZ LLC' }, runId, period: period(), invoices: [bill], contacts, credits: [], options: {},
    ledger: zoho.ledger, saveOrganisation: async () => {}, baseCurrency: 'AED', ...extra,
  });
}

test('a Zoho UAE sync stores the Zoho checks with the document checks, and saves the tax profile', async t => {
  await run(t, 961, 9961, { accounting, taxProfile: { isTaxRegistered: true, isFreeZone: false, taxRegNoLabel: 'TRN' } });
  const issues = issuesOf(961, 9961);
  assert.equal(issues.purchase_tax_missing.count, 1);
  assert.equal(issues.purchase_tax_missing.potential_value_gbp, 100);
  assert.equal(issues.journal_vat_control.count, 1);
  assert.equal(issues.journal_vat_control.period_checked, period().key, 'scoped to the sync\'s period, as the Xero journal checks are');
  assert.equal(issues.bank_balance.period_checked, 'needs_zoho_bank_access');
  assert.equal(issues.bill_or_direct.period_checked, 'needs_zoho_expense_access');
  assert.equal(issues.dividend_status.period_checked, 'not_applicable_uae');
  assert.equal(issues.suspense_open_balance.period_checked, 'unavailable_zoho');
  assert.equal(issues.suspense_open_balance.count, null);
  assert.ok(issues.duplicate_bills && issues.old_unpaid_bills, 'the document checks still run');
  assert.equal(profiles.get(961).region, 'AE');
  assert.equal(JSON.parse(profiles.get(961).profile_json).isTaxRegistered, true);
});

test('Duplicate Contacts (Zoho): every active contact is compared, as for Xero, not only those used on an invoice or bill', async t => {
  const both = [...contacts, { contactID: 'v9', name: 'Supplier One', contactStatus: 'ACTIVE' }]; // the copy is on no bill
  await run(t, 966, 9966, { accounting, contacts: both, taxProfile: { isTaxRegistered: true, isFreeZone: false, taxRegNoLabel: 'TRN' } });
  assert.equal(issuesOf(966, 9966).duplicate_contacts.count, 1);
});

test('a cache-only re-run (no fresh profile) uses the stored one: not registered means no Purchase Tax Missing', async t => {
  profiles.set(962, { region: 'AE', profile_json: JSON.stringify({ isTaxRegistered: false }) });
  await run(t, 962, 9962, { accounting, taxProfile: null });
  assert.equal(issuesOf(962, 9962).purchase_tax_missing.period_checked, 'not_vat_registered');
  assert.equal(JSON.parse(profiles.get(962).profile_json).isTaxRegistered, false, 'the stored copy is not overwritten');
});

test('with banking refused, a Banking page reading under 7 days old feeds Bank Balance and Unprocessed Bank', async t => {
  reading = { readAtUnix: Math.floor(Date.parse('2026-11-09T09:00:00Z') / 1000), rows: [
    { account_name: 'Main Bank Account', account_number: 'xx01', uncategorised: 3, currency: 'AED', amount_in_bank: '900.000', amount_in_books: '1000.000' },
  ] };
  try {
    await run(t, 963, 9963, { accounting, taxProfile: { isTaxRegistered: true } });
    const issues = issuesOf(963, 9963);
    assert.equal(issues.bank_balance.count, 1);
    assert.equal(issues.bank_balance.potential_value_gbp, 100);
    assert.equal(issues.unprocessed_bank.count, 1, 'one account');
    const row = JSON.parse(getDb().prepare("SELECT detail_json FROM issue_findings WHERE org_id = 963 AND run_id = 9963 AND check_type = 'unprocessed_bank'").get().detail_json);
    assert.equal(row.itemsToReconcile, 3);
  } finally { reading = null; }
});

test('no accounting data (QuickBooks, or an older caller): exactly the checks there were before', async t => {
  await run(t, 964, 9964, { ledger: qbo.ledger });
  await run(t, 965, 9965, {});
  const expected = ['contact_defaults', 'duplicate_bills', 'duplicate_contacts', 'duplicate_invoices', 'old_purchase_credits',
    'old_sales_credits', 'old_unpaid_bills', 'old_unpaid_invoices', 'unapproved_bills', 'unapproved_invoices', 'undocumented_bills'];
  assert.deepEqual(Object.keys(issuesOf(964, 9964)).sort(), expected);
  assert.deepEqual(Object.keys(issuesOf(965, 9965)).sort(), expected);
  assert.equal(profiles.has(964) || profiles.has(965), false, 'nothing saved for them');
});
