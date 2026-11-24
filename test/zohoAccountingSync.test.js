// A Zoho Books sync keeps the accounting data (accounts, tax rates, manual journals, bank lines and
// expenses, invoice and bill lines, the read status) in the entity cache, a cache-only re-run hands the
// checks the same data, and a second sync with nothing changed in Zoho makes no detail calls.
// A fake Zoho (fetch replaced), a fake token table and a disposable SQLite cache (the MySQL copy is
// off: AKRIO_DB_USER unset) stand in; the checks are a stand-in that records what they were given.
// Made-up data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.AKRIO_DB_USER;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akrio-zoho-accounting-'));
process.env.XERO_DASHBOARD_DB_PATH = path.join(dir, 'cache.db');
const { getDb } = require('../src/db/schema');
getDb().pragma('foreign_keys = OFF'); // organisations live in MySQL; the local FK has no rows to point at

const toDbText = value => (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 19).replace('T', ' ');
const stub = (relative, exports) => {
  const file = require.resolve(relative);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub('../src/db/ledgerTokens', {
  getLedgerToken: async () => ({ provider: 'zoho', access_token: 'access-1', refresh_token: 'refresh-1',
    expires_at: toDbText(new Date(Date.now() + 50 * 60 * 1000)), api_domain: 'https://www.zohoapis.com' }),
  saveLedgerToken: async () => {}, deleteLedgerToken: async () => {},
});
stub('../src/db/orgCurrency', { saveOrgCurrency: async () => {}, getStoredOrgCurrency: async () => 'AED' });
stub('../src/db/xeroCacheStore', { hydrateOrgIfEmpty: async () => {}, drain: async () => {}, queueSave: () => {} });
let given = null;
stub('../src/services/ledgerChecks', { runLedgerChecks: async args => { given = args; return { ok: true }; } });

const queries = require('../src/db/queries');
const ORG_ROW = { id: 9301, name: 'Made-up Trading FZ LLC', freeagent_company_id: 'zoho-600000009' };
Object.assign(queries, {
  getOrganisationByFreeAgentCompanyId: async () => ORG_ROW,
  upsertFreeAgentOrganisation: async () => {},
  markOrganisationDisconnectedByFreeAgentCompany: async () => {},
  createSyncRun: async () => 1,
  finishSyncRun: async () => {},
  updateOrganisationAccountingSettings: async () => {},
});
const client = require('../src/services/ledgers/zoho/client');
const { syncLedgerOrganisation } = require('../src/services/ledgerSync');
client.__setSleep(async () => {});

let requests = [];
const json = body => new Response(JSON.stringify({ code: 0, message: 'success', ...body }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const list = (key, rows) => json({ [key]: rows, page_context: { has_more_page: false } });
let invoiceModified = '2026-11-02T10:00:00+0400';
const invoiceRow = () => ({ invoice_id: 'i1', invoice_number: 'INV-1', status: 'sent', customer_id: 'c1', customer_name: 'Made-up Customer',
  date: '2026-11-02', due_date: '2026-11-30', total: 105, balance: 105, currency_code: 'AED', exchange_rate: 1, last_modified_time: invoiceModified });
const routes = {
  '/organizations/600000009': () => json({ organization: { name: 'Made-up Trading FZ LLC', currency_code: 'AED', fiscal_year_start_month: 'january' } }),
  '/transactionlock': () => json({ transaction_lock: [] }),
  '/contacts': () => list('contacts', [{ contact_id: 'c1', contact_name: 'Made-up Customer', contact_type: 'customer', status: 'active', outstanding_receivable_amount_bcy: 105 }]),
  '/invoices': () => list('invoices', [invoiceRow()]),
  '/invoices/i1': () => json({ invoice: { ...invoiceRow(), sub_total: 100, tax_total: 5,
    line_items: [{ line_item_id: 'li1', account_id: 'a-sales', account_name: 'Sales', tax_id: 't-std', tax_percentage: 5, item_total: 100 }] } }),
  '/bills': () => list('bills', []),
  // One credit note: a cache-only run needs something cached in each document list.
  '/creditnotes': () => list('creditnotes', [{ creditnote_id: 'cn1', creditnote_number: 'CN-1', status: 'open', customer_id: 'c1', customer_name: 'Made-up Customer',
    date: '2026-11-05', total: 10, balance: 10, currency_code: 'AED', exchange_rate: 1 }]),
  '/vendorcredits': () => list('vendor_credits', []),
  '/chartofaccounts': () => list('chartofaccounts', [
    { account_id: 'a-sales', account_name: 'Sales', account_code: '', account_type: 'income', is_active: true, last_modified_time: '2026-03-06T08:41:48+0400' },
    { account_id: 'a-bank', account_name: 'Example Bank', account_code: '', account_type: 'bank', is_active: true },
  ]),
  '/settings/taxes': () => list('taxes', [{ tax_id: 't-std', tax_name: 'Standard Rate', tax_percentage: 5, tax_type: 'tax', status: 'Active' }]),
  '/journals': () => list('journals', [{ journal_id: 'j1', journal_date: '2026-11-03', status: 'published', total: 50, bcy_total: 50, last_modified_time: '2026-11-03T09:00:00+0400' }]),
  '/journals/j1': () => json({ journal: { journal_id: 'j1', journal_date: '2026-11-03', status: 'published', last_modified_time: '2026-11-03T09:00:00+0400',
    line_items: [{ account_id: 'a-sales', debit_or_credit: 'credit', amount: 50, bcy_amount: 50 }, { account_id: 'a-bank', debit_or_credit: 'debit', amount: 50, bcy_amount: 50 }] } }),
  '/bankaccounts': () => list('bankaccounts', [{ account_id: 'a-bank', account_name: 'Example Bank', account_type: 'bank', balance: 700, bcy_balance: 700, bank_balance: 650, uncategorized_transactions: 1 }]),
  '/banktransactions': () => list('banktransactions', [{ transaction_id: 'bt1', date: '2026-11-20', amount: 50, transaction_type: 'withdrawal', status: 'uncategorized', account_id: 'a-bank' }]),
  '/expenses': () => list('expenses', []),
};
global.fetch = async input => {
  const url = new URL(String(input));
  requests.push(url);
  const route = routes[url.pathname.replace('/books/v3', '')];
  if (!route) throw new Error(`Unexpected request in test: ${url}`);
  return route();
};
const detailCalls = () => requests.map(u => u.pathname.replace('/books/v3', '')).filter(p => /^\/(journals|invoices|bills|expenses)\/[^/]+$/.test(p));

test('sync, cache-only re-run and an unchanged second sync', async () => {
  await syncLedgerOrganisation('zoho-600000009', null, { period: { type: 'all_transactions' } });
  assert.deepEqual(detailCalls().sort(), ['/invoices/i1', '/journals/j1']);
  const first = given;
  assert.equal(first.accounting.accounts.length, 2);
  assert.equal(first.accounting.accounts.find(a => a.accountID === 'a-bank').bank.bankBalance, 650);
  assert.equal(first.accounting.taxRates[0].taxType, 't-std');
  assert.equal(first.accounting.manualJournals[0].journalLines.length, 2);
  assert.equal(first.accounting.bankTransactions[0].bankTransactionID, 'zbt-bt1');
  assert.deepEqual(first.accounting.readStatus.permissions, { banking: true, expenses: true });
  assert.equal(first.invoices[0].lineItems[0].accountID, 'a-sales');

  // Cache only: no Zoho calls, the same data from the cache.
  requests = [];
  await syncLedgerOrganisation('zoho-600000009', null, { cacheOnly: true, period: { type: 'all_transactions' } });
  assert.equal(requests.length, 0);
  const sortById = (rows, id) => rows.slice().sort((a, b) => String(a[id]).localeCompare(String(b[id])));
  for (const [name, id] of [['accounts', 'accountID'], ['taxRates', 'taxType'], ['manualJournals', 'manualJournalID'], ['bankTransactions', 'bankTransactionID']]) {
    assert.deepEqual(sortById(given.accounting[name], id), sortById(first.accounting[name], id), name);
  }
  assert.deepEqual(given.accounting.readStatus, first.accounting.readStatus);
  assert.deepEqual(given.invoices[0].lineItems, first.invoices[0].lineItems);

  // Nothing changed in Zoho: no detail calls, lines still there.
  requests = [];
  await syncLedgerOrganisation('zoho-600000009', null, { period: { type: 'all_transactions' } });
  assert.deepEqual(detailCalls(), []);
  assert.equal(given.invoices[0].lineItems.length, 1);
  assert.equal(given.accounting.manualJournals[0].journalLines.length, 2);
  assert.equal(given.accounting.readStatus.lineItems.carried, 1);

  // The invoice is edited in Zoho: only it is read again.
  invoiceModified = '2026-11-25T10:00:00+0400';
  requests = [];
  await syncLedgerOrganisation('zoho-600000009', null, { period: { type: 'all_transactions' } });
  assert.deepEqual(detailCalls(), ['/invoices/i1']);
});

test('sync: the bank reconcile status and categorised deposits are read after the line items, kept in the cache, and reused cache-only', async () => {
  routes['/chartofaccounts/transactions'] = () => list('transactions', [
    { categorized_transaction_id: 'r1', transaction_date: '2026-11-04', transaction_type: 'customer_payment', reconcile_status: 'unreconciled', debit_amount: 105, credit_amount: 0 },
    { categorized_transaction_id: 'r2', transaction_date: '2026-11-05', transaction_type: 'expense', reconcile_status: 'reconciled', debit_amount: 0, credit_amount: 20 },
  ]);
  const plain = routes['/banktransactions'];
  routes['/banktransactions'] = () => list('banktransactions', [
    { transaction_id: 'bt1', date: '2026-11-20', amount: 50, transaction_type: 'withdrawal', status: 'uncategorized', account_id: 'a-bank' },
    { transaction_id: 'dp1', date: '2026-11-06', amount: 105, transaction_type: 'sales_without_invoices', status: 'categorized', customer_id: 'c1', account_id: 'a-bank' },
  ]);
  try {
    requests = [];
    await syncLedgerOrganisation('zoho-600000009', null, { period: { type: 'all_transactions' } });
    const paths = requests.map(u => u.pathname.replace('/books/v3', ''));
    assert.ok(paths.indexOf('/chartofaccounts/transactions') > paths.lastIndexOf('/invoices'), 'after the documents and their lines');
    const bank = given.accounting.accounts.find(a => a.accountID === 'a-bank');
    assert.deepEqual(bank.reconciliation.unreconciled.map(t => t.transactionID), ['r1']);
    assert.equal(given.accounting.readStatus.sections.reconciliation.unreconciled, 1);
    assert.ok(given.accounting.bankTransactions.some(row => row.bankTransactionID === 'zrc-dp1'));
    assert.ok(given.accounting.bankTransactions.some(row => row.bankTransactionID === 'zbt-bt1'), 'the uncategorised line is still there');
    requests = [];
    await syncLedgerOrganisation('zoho-600000009', null, { cacheOnly: true, period: { type: 'all_transactions' } });
    assert.equal(requests.length, 0);
    assert.deepEqual(given.accounting.accounts.find(a => a.accountID === 'a-bank').reconciliation.unreconciled.map(t => t.transactionID), ['r1']);
    assert.ok(given.accounting.bankTransactions.some(row => row.bankTransactionID === 'zrc-dp1'));
  } finally {
    delete routes['/chartofaccounts/transactions'];
    routes['/banktransactions'] = plain;
  }
});
