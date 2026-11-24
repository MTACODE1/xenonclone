// Zoho Books accounting reads (accounting.js, mapping.js): the consent scopes, the account-type table,
// the Xero shapes, reading a journal's or document's detail only when it changed, the per-sync cap,
// a connection that does not allow banking or expenses, and Zoho's daily limit. A fake Zoho (fetch
// replaced) and a fake token table stand in; nothing reaches Zoho or a database. All names, ids and
// amounts are made up; the shapes follow real Zoho answers.
const test = require('node:test');
const assert = require('node:assert/strict');

const toDbText = value => (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 19).replace('T', ' ');
const tokenRows = new Map();
const tokensPath = require.resolve('../src/db/ledgerTokens');
require.cache[tokensPath] = {
  id: tokensPath, filename: tokensPath, loaded: true,
  exports: {
    getLedgerToken: async (provider, externalId) => tokenRows.get(`${provider}:${externalId}`) || null,
    saveLedgerToken: async (provider, externalId, token) => {
      const old = tokenRows.get(`${provider}:${externalId}`) || {};
      tokenRows.set(`${provider}:${externalId}`, { ...old, access_token: token.access_token, refresh_token: token.refresh_token,
        expires_at: toDbText(token.expires_at), api_domain: token.api_domain || old.api_domain });
    },
    deleteLedgerToken: async () => {},
  },
};

const client = require('../src/services/ledgers/zoho/client');
const zoho = require('../src/services/ledgers/zoho');
const mapping = require('../src/services/ledgers/zoho/mapping');
const accounting = require('../src/services/ledgers/zoho/accounting');

const ORG = '600000001';
let requests = [];
let handlers = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = extra => json({ code: 0, message: 'success', ...extra });
const page = (key, rows, more = false) => ok({ [key]: rows, page_context: { page: 1, per_page: 200, has_more_page: more } });
const refused = () => json({ code: 57, message: 'You are not authorized to perform this operation' }, 401);
global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const request = { url, method: options.method || 'GET', headers: options.headers || {} };
  requests.push(request);
  for (const handler of handlers) {
    const answer = await handler(request);
    if (answer) return answer;
  }
  throw new Error(`Unexpected request in test: ${url}`);
};
client.__setSleep(async () => {});
const at = path => request => request.url.pathname === `/books/v3${path}`;
const booksCalls = prefix => requests.filter(r => r.url.pathname.startsWith(`/books/v3${prefix}`)).map(r => r.url.pathname.replace('/books/v3', ''));
const tokenCalls = () => requests.filter(r => r.url.pathname === '/oauth/v2/token').length;

test.beforeEach(() => {
  requests = []; handlers = []; tokenRows.clear(); client.__reset();
  process.env.ZOHO_CLIENT_ID = 'test-client-id';
  process.env.ZOHO_CLIENT_SECRET = 'test-client-secret';
  process.env.ZOHO_REDIRECT_URI = 'https://verify.example.test/auth/zoho/callback';
  delete process.env.ZOHO_MAX_DETAIL_READS;
  tokenRows.set(`zoho:${ORG}`, {
    provider: 'zoho', external_id: ORG, access_token: 'access-1', refresh_token: 'refresh-1',
    expires_at: toDbText(new Date(Date.now() + 50 * 60 * 1000)), api_domain: 'https://www.zohoapis.com', accounts_server: 'https://accounts.zoho.com',
  });
});

// Made-up rows shaped like Zoho's answers.
const accountRow = (id, name, type, extra = {}) => ({
  account_id: id, account_name: name, account_code: '', account_type: type, currency_code: 'AED',
  is_active: true, is_system_account: false, parent_account_id: '', depth: 0, has_attachment: false,
  last_modified_time: '2026-03-06T08:41:48+0400', ...extra,
});
const CHART = [
  accountRow('a-bank', 'Example Bank Current', 'bank'),
  accountRow('a-card', 'Example Card', 'credit_card'),
  accountRow('a-ar', 'Accounts Receivable', 'accounts_receivable', { is_system_account: true }),
  accountRow('a-ap', 'Accounts Payable', 'accounts_payable', { is_system_account: true }),
  accountRow('a-vat', 'VAT Payable', 'other_current_liability', { is_system_account: true }),
  accountRow('a-sales', 'Sales', 'income', { account_code: '4000' }),
  accountRow('a-rent', 'Rent', 'expense', { is_active: false }),
  accountRow('a-re', 'Retained Earnings', 'equity', { is_system_account: true }),
];
const TAXES = [
  { tax_id: 't-std', tax_name: 'Standard Rate', tax_percentage: 5, tax_type: 'tax', is_inactive: false, status: 'Active', tax_authority_name: 'Tax Office', country_code: 'AE', is_default_tax: true, last_modified_time: '2026-10-28T08:24:11+0400' },
  { tax_id: 't-zero', tax_name: 'Zero Rate', tax_percentage: 0, tax_type: 'tax', is_inactive: true, status: 'Inactive' },
];
const journalRow = (id, date, modified) => ({
  journal_id: id, journal_date: date, entry_number: `MJ-${id}`, reference_number: '', status: 'published', notes: 'Made-up accrual',
  journal_type: 'both', total: 900, bcy_total: 900, last_modified_time: modified,
});
const journalDetail = (row) => ({
  ...row, currency_code: 'AED', exchange_rate: 1, documents: [],
  line_items: [
    { line_id: `${row.journal_id}-1`, account_id: 'a-rent', account_name: 'Rent', account_code: '', debit_or_credit: 'debit',
      tax_id: 't-std', tax_name: 'Standard Rate', tax_percentage: 5, amount: 800, bcy_amount: 800, selected_account: { account_type: 'expense' } },
    { line_id: `${row.journal_id}-2`, account_id: 'a-bank', account_name: 'Example Bank Current', account_code: '', debit_or_credit: 'credit',
      tax_id: '', tax_name: '', tax_percentage: '', amount: 840, bcy_amount: 840 },
  ],
});
const bankRow = (id, name, uncategorised, extra = {}) => ({
  account_id: id, account_name: name, account_type: 'bank', currency_code: 'AED', balance: 1500.5, bcy_balance: 1500.5,
  bank_balance: 0, uncategorized_transactions: uncategorised, is_active: true, ...extra,
});
const expenseRow = (id, date, modified) => ({
  expense_id: id, date, account_name: 'Rent', paid_through_account_name: 'Example Card', description: 'Made-up office rent',
  currency_code: 'AED', total: 105, bcy_total: 105, total_without_tax: 100, status: 'nonbillable', vendor_name: 'Example Landlord',
  reference_number: 'R-1', last_modified_time: modified,
});
const expenseDetail = row => ({
  ...row, account_id: 'a-rent', paid_through_account_id: 'a-card', tax_id: 't-std', tax_name: 'Standard Rate', tax_percentage: 5,
  tax_amount: 5, amount: 100, sub_total: 100, is_inclusive_tax: false, exchange_rate: 1, vendor_id: 'v-1',
});

// A Zoho that answers every accounting list. Options switch parts off.
function fakeZoho({ journals = [journalRow('j1', '2026-11-20', '2026-11-20T10:00:00+0400')], banking = true, expenses = true, bankingAnswer = null } = {}) {
  handlers = [
    r => at('/chartofaccounts')(r) && page('chartofaccounts', CHART),
    r => at('/settings/taxes')(r) && page('taxes', TAXES),
    r => at('/journals')(r) && page('journals', journals),
    r => r.url.pathname.startsWith('/books/v3/journals/') && (() => {
      const id = decodeURIComponent(r.url.pathname.split('/').pop());
      const row = journals.find(j => j.journal_id === id);
      return ok({ journal: journalDetail(row) });
    })(),
    r => at('/bankaccounts')(r) && (bankingAnswer ? bankingAnswer() : banking
      ? page('bankaccounts', [bankRow('a-bank', 'Example Bank Current', 2), bankRow('a-card', 'Example Card', 0, { account_type: 'credit_card', bank_balance: -20 })])
      : refused()),
    r => at('/banktransactions')(r) && page('banktransactions', [
      { transaction_id: 'bt1', date: '2026-11-21', amount: 250, transaction_type: 'deposit', status: 'uncategorized', payee: 'Made-up Customer', account_id: 'a-bank', currency_code: 'AED' },
      { transaction_id: 'bt2', date: '2026-11-22', amount: 40, transaction_type: 'withdrawal', status: 'uncategorized', account_id: 'a-bank' },
      { transaction_id: 'bt3', date: '2026-11-22', amount: 1, transaction_type: 'withdrawal', status: 'categorized', account_id: 'a-bank' },
    ]),
    r => at('/expenses')(r) && (expenses ? page('expenses', [expenseRow('e1', '2026-11-10', '2026-11-10T09:00:00+0400')]) : refused()),
    r => r.url.pathname.startsWith('/books/v3/expenses/') && ok({ expense: expenseDetail(expenseRow('e1', '2026-11-10', '2026-11-10T09:00:00+0400')) }),
  ];
}

test('the consent asks for banking and expenses, read-only, and no fixed-asset scope', () => {
  assert.ok(client.SCOPES.includes('ZohoBooks.banking.READ'));
  assert.ok(client.SCOPES.includes('ZohoBooks.expenses.READ'));
  assert.ok(client.SCOPES.every(scope => scope.endsWith('.READ')));
  assert.ok(!client.SCOPES.some(scope => /fixedasset/i.test(scope)));
  const scope = new URL(zoho.buildConsentUrl('state-1')).searchParams.get('scope').split(',');
  assert.deepEqual(scope, client.SCOPES);
});

test('every Zoho account type maps to a Xero type and class', () => {
  const expected = {
    bank: ['BANK', 'ASSET'], cash: ['BANK', 'ASSET'], credit_card: ['BANK', 'ASSET'], other_current_asset: ['CURRENT', 'ASSET'],
    accounts_receivable: ['CURRENT', 'ASSET'], fixed_asset: ['FIXED', 'ASSET'], other_asset: ['NONCURRENT', 'ASSET'],
    stock: ['INVENTORY', 'ASSET'], other_current_liability: ['CURRLIAB', 'LIABILITY'], accounts_payable: ['CURRLIAB', 'LIABILITY'],
    other_liability: ['LIABILITY', 'LIABILITY'], long_term_liability: ['TERMLIAB', 'LIABILITY'], equity: ['EQUITY', 'EQUITY'],
    income: ['REVENUE', 'REVENUE'], other_income: ['OTHERINCOME', 'REVENUE'], expense: ['EXPENSE', 'EXPENSE'],
    other_expense: ['EXPENSE', 'EXPENSE'], cost_of_goods_sold: ['DIRECTCOSTS', 'EXPENSE'],
  };
  for (const [zohoType, [type, klass]] of Object.entries(expected)) {
    assert.deepEqual([mapping.accountTypeOf(zohoType).type, mapping.accountTypeOf(zohoType)._class], [type, klass], zohoType);
  }
  // Unknown types are placed by name, or left empty; never guessed as something else.
  assert.equal(mapping.accountTypeOf('some_new_liability').type, 'LIABILITY');
  assert.equal(mapping.accountTypeOf('mystery').type, null);
  assert.equal(mapping.accountTypeOf('credit_card').bankAccountType, 'CREDITCARD');
});

test('accounts in the Xero shape: blank codes are null, inactive is ARCHIVED, control accounts marked', () => {
  const accounts = CHART.map(mapping.mapAccount);
  const byId = Object.fromEntries(accounts.map(a => [a.accountID, a]));
  assert.equal(byId['a-bank'].code, null);
  assert.equal(byId['a-sales'].code, '4000');
  assert.equal(byId['a-rent'].status, 'ARCHIVED');
  assert.equal(byId['a-ar'].systemAccount, 'DEBTORS');
  assert.equal(byId['a-ap'].systemAccount, 'CREDITORS');
  assert.equal(byId['a-re'].systemAccount, 'RETAINEDEARNINGS');
  assert.equal(byId['a-vat'].systemAccount, null);
  assert.equal(byId['a-bank'].updatedDateUTC, '2026-03-06T04:41:48.000Z');
  assert.equal(byId['a-bank'].zohoAccountType, 'bank');
});

test('journal lines are signed in the organisation currency; tax from the line or worked out', () => {
  const journal = mapping.mapManualJournal({ ...journalDetail(journalRow('j9', '2026-11-01', 'x')), currency_code: 'USD', exchange_rate: 3.6725,
    line_items: [
      { line_id: 'l1', account_id: 'a-rent', debit_or_credit: 'debit', amount: 100, bcy_amount: 367.25, tax_id: 't-std', tax_percentage: 5 },
      { line_id: 'l2', account_id: 'a-bank', debit_or_credit: 'credit', amount: 105, bcy_amount: 385.61, tax_id: '' },
    ] });
  assert.equal(journal.status, 'POSTED');
  assert.equal(journal.journalLines[0].lineAmount, 367.25);
  assert.equal(journal.journalLines[0].amountInCurrency, 100);
  assert.equal(journal.journalLines[0].taxAmount, 18.36);
  assert.equal(journal.journalLines[0].taxAmountEstimated, true);
  assert.equal(journal.journalLines[1].lineAmount, -385.61);
  assert.equal(journal.journalLines[1].taxType, 'NONE');
  assert.equal(Math.round(journal.currencyRate * 3.6725 * 1000) / 1000, 1);

  const line = mapping.mapDocumentLine({ item_total: 210, tax_id: 't-std', tax_percentage: 5, line_item_taxes: [{ tax_id: 't-std', tax_amount: 10 }] }, { inclusive: true });
  assert.deepEqual([line.lineAmount, line.taxAmount, line.taxAmountEstimated], [210, 10, false]);
  const inclusive = mapping.mapDocumentLine({ item_total: 210, tax_id: 't-std', tax_percentage: 5 }, { inclusive: true });
  assert.equal(inclusive.taxAmount, 10);
  const tax = mapping.mapTaxRate(TAXES[1]);
  assert.deepEqual([tax.taxType, tax.status, tax.effectiveRate], ['t-zero', 'ARCHIVED', 0]);
});

test('first read: chart, taxes, journal lines, bank accounts with balances, uncategorised lines, expenses', async () => {
  fakeZoho();
  const progress = [];
  const result = await accounting.fetchAccounting(ORG, { emit: p => progress.push(p), cached: async () => [] });
  assert.equal(result.accounts.fresh, true);
  const bank = result.accounts.rows.find(a => a.accountID === 'a-bank');
  assert.equal(bank.bank.bookBalance, 1500.5);
  assert.equal(bank.bank.uncategorizedCount, 2);
  assert.equal(result.accounts.rows.find(a => a.accountID === 'a-card').bank.bankBalance, -20);
  assert.equal(result.accounts.rows.find(a => a.accountID === 'a-sales').bank, null);
  assert.equal(result.taxRates.rows.length, 2);
  const [journal] = result.manualJournals.rows;
  assert.equal(journal.linesRead, true);
  assert.equal(journal.journalLines.length, 2);
  assert.equal(journal.detailKey, 't:2026-11-20T10:00:00+0400');
  const lines = result.bankTransactions.rows.filter(row => row.isStatementLine);
  assert.deepEqual(lines.map(l => [l.bankTransactionID, l.type, l.status]), [['zbt-bt1', 'RECEIVE', 'UNCATEGORISED'], ['zbt-bt2', 'SPEND', 'UNCATEGORISED']]);
  const expense = result.bankTransactions.rows.find(row => row.source === 'zoho_expense');
  assert.equal(expense.bankTransactionID, 'exp-e1');
  assert.equal(expense.bankAccount.accountID, 'a-card');
  assert.deepEqual(expense.lineItems.map(l => [l.accountID, l.taxType, l.lineAmount, l.taxAmount]), [['a-rent', 't-std', 100, 5]]);
  assert.deepEqual(result.status.permissions, { banking: true, expenses: true });
  // Only the account Zoho says has uncategorised lines is asked for them.
  assert.equal(requests.filter(r => r.url.pathname === '/books/v3/banktransactions').length, 1);
  const btRequest = requests.find(r => r.url.pathname === '/books/v3/banktransactions');
  assert.equal(btRequest.url.searchParams.get('account_id'), 'a-bank');
  assert.equal(requests.find(r => r.url.pathname === '/books/v3/chartofaccounts').url.searchParams.get('filter_by'), 'AccountType.All');
});

test('an unchanged journal or expense is not read again; a changed one is', async () => {
  fakeZoho();
  const first = await accounting.fetchAccounting(ORG, { cached: async () => [] });
  const cache = { manual_journal: first.manualJournals.rows, bank_transaction: first.bankTransactions.rows, account: first.accounts.rows };
  requests = [];
  const second = await accounting.fetchAccounting(ORG, { cached: async type => cache[type] || [] });
  assert.deepEqual(booksCalls('/journals/'), []);
  assert.deepEqual(booksCalls('/expenses/'), []);
  assert.equal(second.manualJournals.rows[0].journalLines.length, 2);
  assert.equal(second.bankTransactions.rows.find(r => r.source === 'zoho_expense').lineItems.length, 1);

  // Edited in Zoho: last_modified_time moves on, so its lines are read again.
  fakeZoho({ journals: [journalRow('j1', '2026-11-20', '2026-11-24T08:00:00+0400')] });
  requests = [];
  await accounting.fetchAccounting(ORG, { cached: async type => cache[type] || [] });
  assert.deepEqual(booksCalls('/journals/'), ['/journals/j1']);
});

test('invoice and bill lines: read when new or changed, carried when not, voided skipped', async () => {
  const invoiceRow = (id, date, modified, extra = {}) => ({ invoice_id: id, invoice_number: `INV-${id}`, status: 'sent', customer_id: 'c1', customer_name: 'Made-up Customer',
    date, due_date: date, total: 105, balance: 105, currency_code: 'AED', exchange_rate: 1, last_modified_time: modified, ...extra });
  const billRow = (id, date, modified) => ({ bill_id: id, bill_number: `B-${id}`, status: 'open', vendor_id: 'v1', vendor_name: 'Made-up Supplier',
    date, due_date: date, total: 210, balance: 210, currency_code: 'AED', exchange_rate: 1, last_modified_time: modified });
  handlers = [
    r => r.url.pathname.startsWith('/books/v3/invoices/') && ok({ invoice: { ...invoiceRow(r.url.pathname.split('/').pop(), '2026-11-01', 'x'),
      sub_total: 100, tax_total: 5, is_inclusive_tax: false,
      line_items: [{ line_item_id: 'li1', account_id: 'a-sales', account_name: 'Sales', tax_id: 't-std', tax_name: 'Standard Rate', tax_percentage: 5, item_total: 100, quantity: 1, rate: 100 }] } }),
    r => r.url.pathname.startsWith('/books/v3/bills/') && ok({ bill: { ...billRow(r.url.pathname.split('/').pop(), '2026-11-01', 'x'),
      sub_total: 200, tax_total: 10, line_items: [{ line_item_id: 'bl1', account_id: 'a-rent', account_code: '', tax_id: 't-std', tax_percentage: 5, item_total: 200 }] } }),
  ];
  const listed = () => ({
    invoices: [zoho.mapInvoice(invoiceRow('i1', '2026-11-01', 'm1')), zoho.mapInvoice(invoiceRow('i2', '2026-11-02', 'm2')),
      zoho.mapInvoice(invoiceRow('i3', '2026-11-03', 'm3', { status: 'void' }))],
    bills: [zoho.mapBill(billRow('b1', '2026-11-04', 'm4'))],
  });
  const docs = listed();
  const first = await zoho.fetchLineItems(ORG, docs, { cachedDocuments: async () => [] });
  assert.deepEqual(booksCalls('/'), ['/bills/b1', '/invoices/i2', '/invoices/i1']); // newest first, voided not read
  assert.equal(first.read, 3);
  assert.deepEqual(docs.invoices[0].lineItems.map(l => [l.accountID, l.taxType, l.lineAmount, l.taxAmount]), [['a-sales', 't-std', 100, 5]]);
  assert.equal(docs.invoices[0].subTotal, 100);
  assert.equal(docs.bills[0].lineItems[0].lineAmount, 200);
  assert.equal(docs.invoices[0].detailKey, 't:m1');

  const cache = [...docs.invoices, ...docs.bills].map(doc => JSON.parse(JSON.stringify(doc)));
  requests = [];
  const again = listed();
  again.invoices[1] = zoho.mapInvoice(invoiceRow('i2', '2026-11-02', 'm2-edited'));
  const second = await zoho.fetchLineItems(ORG, again, { cachedDocuments: async () => cache });
  assert.deepEqual(booksCalls('/'), ['/invoices/i2']);
  assert.equal(second.carried, 2);
  assert.equal(again.invoices[0].lineItems.length, 1);
  assert.equal(again.invoices[0].lineItemsStale, false);
});

test('the per-sync cap: newest first, the rest keep cached lines, and it is said out loud', async t => {
  const logged = [];
  t.mock.method(console, 'log', line => logged.push(String(line)));
  const journals = [journalRow('j1', '2026-01-10', 'a'), journalRow('j2', '2026-11-10', 'b'), journalRow('j3', '2026-06-10', 'c')];
  fakeZoho({ journals, banking: false, expenses: false });
  const cachedJ3 = { ...mapping.mapManualJournal(journalDetail(journalRow('j3', '2026-06-10', 'old'))) };
  const budget = accounting.createReadBudget(1);
  const progress = [];
  const result = await accounting.fetchAccounting(ORG, { readBudget: budget, emit: p => progress.push(p), cached: async type => (type === 'manual_journal' ? [cachedJ3] : []) });
  assert.deepEqual(booksCalls('/journals/'), ['/journals/j2']);
  const byId = Object.fromEntries(result.manualJournals.rows.map(j => [j.manualJournalID, j]));
  assert.equal(byId.j2.linesRead, true);
  assert.equal(byId.j3.linesRead, true);
  assert.equal(byId.j3.linesStale, true);
  assert.equal(byId.j3.detailKey, 't:old'); // still old: the next sync reads it
  assert.equal(byId.j1.linesRead, false);
  assert.equal(budget.capReached, true);
  const lines = await zoho.fetchLineItems(ORG, { invoices: [], bills: [] }, { readBudget: budget, emit: p => progress.push(p) });
  assert.equal(lines.notReadAllSections, 2);
  assert.ok(progress.some(p => /limit of 1 detail reads per sync/.test(p.message)));
  assert.ok(logged.some(line => /not read this sync/.test(line)));

  process.env.ZOHO_MAX_DETAIL_READS = '25';
  assert.equal(accounting.createReadBudget().limit, 25);
  delete process.env.ZOHO_MAX_DETAIL_READS;
  assert.equal(accounting.createReadBudget().limit, accounting.DEFAULT_MAX_DETAIL_READS);
});

test('a connection without banking or expenses access: recorded, no token refresh, the sync carries on', async () => {
  fakeZoho({ banking: false, expenses: false });
  const cachedBank = [mapping.mapUncategorisedLine({ transaction_id: 'old1', amount: 5, transaction_type: 'deposit' })];
  const cachedAccounts = [{ ...mapping.mapAccount(CHART[0]), bank: { bookBalance: 1 } }];
  const result = await accounting.fetchAccounting(ORG, { cached: async type => (type === 'bank_transaction' ? cachedBank : type === 'account' ? cachedAccounts : []) });
  assert.deepEqual(result.status.permissions, { banking: false, expenses: false });
  assert.equal(result.status.sections.banking.reason, 'not_authorized');
  assert.equal(tokenCalls(), 0); // the token had already worked on the chart of accounts
  assert.equal(requests.filter(r => r.url.pathname === '/books/v3/bankaccounts').length, 1);
  // Nothing stale is kept for a list the connection refuses.
  assert.deepEqual(result.bankTransactions.rows, []);
  assert.equal(result.bankTransactions.fresh, true);
  assert.equal(result.accounts.rows.find(a => a.accountID === 'a-bank').bank, null);
  assert.equal(result.manualJournals.rows.length, 1);
});

test('the first call refused with 401 still gets one token refresh, then is a permission answer', async () => {
  handlers = [
    r => r.url.pathname === '/oauth/v2/token' && json({ access_token: 'access-2', expires_in: 3600, api_domain: 'https://www.zohoapis.com' }),
    r => at('/bankaccounts')(r) && refused(),
  ];
  await assert.rejects(client.apiGet(ORG, '/bankaccounts', {}, { optionalScope: true }), error => error.notAuthorized === true && error.status === 401);
  assert.equal(tokenCalls(), 1);
});

test("Zoho's daily limit stops the optional reads and keeps the cached copies", async () => {
  fakeZoho();
  handlers.unshift(r => at('/journals')(r) && json({ code: 45, message: 'You have reached the maximum number of API calls for today' }, 429));
  const cachedJournals = [mapping.mapManualJournal(journalDetail(journalRow('j-old', '2026-10-01', 'x')))];
  const result = await accounting.fetchAccounting(ORG, { cached: async type => (type === 'manual_journal' ? cachedJournals : []) });
  assert.equal(result.manualJournals.fresh, false);
  assert.deepEqual(result.manualJournals.rows, cachedJournals);
  assert.equal(result.status.sections.manualJournals.reason, 'daily_limit');
  assert.equal(result.status.sections.banking.reason, 'daily_limit');
  assert.deepEqual(result.status.permissions, { banking: null, expenses: null });
  assert.deepEqual(booksCalls('/bankaccounts'), []);
  assert.deepEqual(booksCalls('/expenses'), []);
  assert.equal(result.accounts.fresh, true); // read before the limit
  assert.equal(result.bankTransactions.fresh, false);
});

test('a refused sign-in still stops the sync', async () => {
  tokenRows.set(`zoho:${ORG}`, { ...tokenRows.get(`zoho:${ORG}`), expires_at: toDbText(new Date(Date.now() - 1000)) });
  handlers = [r => r.url.pathname === '/oauth/v2/token' && json({ error: 'invalid_code' })];
  await assert.rejects(accounting.fetchAccounting(ORG, { cached: async () => [] }), error => error.authFailure === true);
});

// ---------------- review fixes (regression tests) ----------------

test('detail reads keep within the day\'s call allowance, leaving the reserve for the compulsory lists', async t => {
  t.mock.method(console, 'log', () => {});
  process.env.ZOHO_DAILY_CALL_ALLOWANCE = '205';
  process.env.ZOHO_DAILY_CALL_RESERVE = '200';
  try {
    const journals = [journalRow('j1', '2026-11-01', 'a'), journalRow('j2', '2026-11-02', 'b'), journalRow('j3', '2026-11-03', 'c'), journalRow('j4', '2026-11-04', 'd')];
    fakeZoho({ journals, banking: false, expenses: false });
    const budget = accounting.createReadBudget(400);
    const progress = [];
    await accounting.fetchAccounting(ORG, { readBudget: budget, emit: p => progress.push(p), cached: async () => [] });
    // chart + taxes + journal list = 3 calls before the details, so 205 - 200 - 3 = 2 details fit today.
    assert.equal(booksCalls('/journals/').length, 2);
    assert.equal(budget.allowanceReached, true);
    assert.equal(client.callsToday(ORG), requests.filter(r => r.url.pathname.startsWith('/books/v3')).length);
    await zoho.fetchLineItems(ORG, { invoices: [], bills: [] }, { readBudget: budget, emit: p => progress.push(p) });
    assert.ok(progress.some(p => /day's allowance of Zoho calls/.test(p.message)));
  } finally {
    delete process.env.ZOHO_DAILY_CALL_ALLOWANCE;
    delete process.env.ZOHO_DAILY_CALL_RESERVE;
  }
});

test('chart not read and banking refused: the cached accounts lose their old bank details', async t => {
  t.mock.method(console, 'log', () => {});
  fakeZoho({ banking: false, expenses: false });
  handlers.unshift(r => at('/chartofaccounts')(r) && json({ code: 1, message: 'Made-up failure' }, 400));
  const cachedAccounts = [{ ...mapping.mapAccount(CHART[0]), bank: { bookBalance: 1, bankBalance: 2 } }];
  const result = await accounting.fetchAccounting(ORG, { cached: async type => (type === 'account' ? cachedAccounts : []) });
  assert.equal(result.status.permissions.banking, false);
  assert.equal(result.accounts.rows.find(a => a.accountID === 'a-bank').bank, null);
  assert.equal(result.accounts.fresh, true, 'the cache is rewritten without them');
  // Any other banking failure keeps them, marked stale.
  requests = []; client.__reset();
  fakeZoho({ bankingAnswer: () => json({ code: 1, message: 'Made-up failure' }, 400), expenses: false });
  handlers.unshift(r => at('/chartofaccounts')(r) && json({ code: 1, message: 'Made-up failure' }, 400));
  const other = await accounting.fetchAccounting(ORG, { cached: async type => (type === 'account' ? cachedAccounts : []) });
  assert.equal(other.accounts.rows.find(a => a.accountID === 'a-bank').bank.stale, true);
});

test('a refused optional list right after a routine token refresh spends no second refresh', async () => {
  let issued = 1;
  handlers = [
    r => r.url.pathname === '/oauth/v2/token' && json({ access_token: `access-${++issued}`, expires_in: 3600, api_domain: 'https://www.zohoapis.com' }),
    r => at('/settings/taxes')(r) && page('taxes', TAXES),
    r => at('/bankaccounts')(r) && refused(),
  ];
  await client.apiGet(ORG, '/settings/taxes'); // the sign-in works with access-1
  // access-1 is about to expire, so the next call refreshes it first (a routine refresh, not a refused call).
  tokenRows.set(`zoho:${ORG}`, { ...tokenRows.get(`zoho:${ORG}`), expires_at: toDbText(new Date(Date.now() + 30 * 1000)) });
  await assert.rejects(client.apiGet(ORG, '/bankaccounts', {}, { optionalScope: true }), error => error.notAuthorized === true);
  assert.equal(tokenCalls(), 1, 'only the routine refresh');
});
