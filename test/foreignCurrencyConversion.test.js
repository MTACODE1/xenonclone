// Documents in another currency on a Zoho Books / QuickBooks client (a USD invoice in an AED organisation) are
// converted to the client's own currency for every total, with the same checkRules.amountInBase the Xero checks
// use. Zoho's exchange_rate (organisation currency per one unit of the document's) is turned round into Xero's
// currencyRate (document currency per one unit of the organisation's); the vendor credit list has no rate, so it
// is read one credit at a time, and only for credits in another currency. A foreign document with no usable rate
// is listed and counted but never added in as if it were 1:1.
// Throwaway SQLite; MySQL and Zoho are stand-ins. Nothing reaches a real ledger or database. Made-up data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ejs = require('ejs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akrio-foreign-currency-'));
process.env.XERO_DASHBOARD_DB_PATH = path.join(dir, 'test.db');
delete process.env.AKRIO_DB_USER;

const fakeQuery = async sql => {
  if (/SELECT 1 FROM akrio_health_scores/.test(sql)) return [[{ 1: 1 }], []];
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
const zohoClient = require('../src/services/ledgers/zoho/client');
const zoho = require('../src/services/ledgers/zoho');
const qbo = require('../src/services/ledgers/quickbooks');
const { currencyPrefix, formatMoney } = require('../src/services/money');
const { groupSupplierTransactions } = require('../src/services/checkPresentation');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const round2 = value => Math.round(value * 100) / 100;
const ZOHO_LEDGER = zoho.ledger;
const FREEAGENT_LEDGER = { key: 'freeagent', purchaseCredits: false, drafts: true }; // as freeagentSync.js passes it

// ===================== Zoho mapping =====================

test('Zoho: exchange_rate (AED per USD) becomes Xero\'s currencyRate (USD per AED)', () => {
  const row = (extra) => ({ invoice_id: '1', status: 'sent', date: '2026-09-01', total: 100, balance: 100, ...extra });
  assert.equal(zoho.mapInvoice(row({ currency_code: 'USD', exchange_rate: 3.6725 })).currencyRate, 1 / 3.6725);
  assert.equal(zoho.mapInvoice(row({ currency_code: 'AED', exchange_rate: 1 })).currencyRate, 1, 'own currency: 1');
  assert.equal(zoho.mapInvoice(row({ currency_code: 'GBP', exchange_rate: '4.757' })).currencyRate, 1 / 4.757, 'text is read as a number');
  for (const bad of [undefined, null, '', 0, -2, 'abc', Infinity]) {
    assert.equal(zoho.mapInvoice(row({ currency_code: 'USD', exchange_rate: bad })).currencyRate, null, `no usable rate: ${String(bad)}`);
  }
  assert.equal(zoho.mapBill({ bill_id: '2', status: 'open', total: 10, balance: 10, currency_code: 'USD', exchange_rate: 3.6725 }).currencyRate, 1 / 3.6725);
  assert.equal(zoho.mapSalesCredit({ creditnote_id: '3', status: 'open', total: 10, balance: 10, currency_code: 'EUR', exchange_rate: 4 }).currencyRate, 0.25);
  assert.equal(zoho.mapVendorCredit({ vendor_credit_id: '4', status: 'open', total: 10, balance: 10, currency_code: 'USD' }).currencyRate, null,
    'the vendor credit list has no rate: filled in by fetchDocuments');
});

// A stand-in for client.apiGet: the lists, and the one-credit call, recorded in order.
function fakeZoho(lists, details = {}) {
  const calls = [];
  const original = zohoClient.apiGet;
  zohoClient.apiGet = async (externalId, pathName, params = {}) => {
    calls.push(pathName);
    const detail = pathName.match(/^\/vendorcredits\/(.+)$/);
    if (detail) {
      const answer = details[decodeURIComponent(detail[1])];
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error(`unexpected vendor credit read ${pathName}`);
      return { code: 0, vendor_credit: answer };
    }
    const key = { '/contacts': 'contacts', '/invoices': 'invoices', '/bills': 'bills', '/creditnotes': 'creditnotes', '/vendorcredits': 'vendor_credits' }[pathName];
    if (!key) throw new Error(`unexpected call ${pathName}`);
    return { code: 0, [key]: lists[key] || [], page_context: { has_more_page: false } };
  };
  return { calls, restore: () => { zohoClient.apiGet = original; } };
}
const vendorCredit = (id, currency) => ({ vendor_credit_id: id, vendor_credit_number: `DN-${id}`, status: 'open', date: '2026-06-01',
  total: 100, balance: 100, vendor_id: 'v1', vendor_name: 'Example Supplier', currency_code: currency });

test('Zoho: a vendor credit\'s rate is read one at a time, only for credits in another currency', async t => {
  const fake = fakeZoho({ vendor_credits: [vendorCredit('1', 'AED'), vendorCredit('2', 'USD'), vendorCredit('3', 'GBP'), vendorCredit('4', 'AED'), vendorCredit('5', null)] },
    { 2: { exchange_rate: 3.6725, currency_code: 'USD' }, 3: { exchange_rate: 4.757, currency_code: 'GBP' } });
  t.after(fake.restore);
  const docs = await zoho.fetchDocuments('600000001', { baseCurrency: 'AED' });
  assert.deepEqual(fake.calls.filter(c => c.startsWith('/vendorcredits/')), ['/vendorcredits/2', '/vendorcredits/3'],
    'one read for each foreign credit, none for the AED ones or the one with no currency');
  const rate = Object.fromEntries(docs.credits.map(c => [c.creditNoteID, c.currencyRate]));
  assert.deepEqual(rate, { 'vc-1': 1, 'vc-2': 1 / 3.6725, 'vc-3': 1 / 4.757, 'vc-4': 1, 'vc-5': null });
});

test('Zoho: an organisation whose vendor credits are all in its own currency makes no extra call', async t => {
  const fake = fakeZoho({ vendor_credits: [vendorCredit('1', 'AED'), vendorCredit('2', 'aed')] });
  t.after(fake.restore);
  const docs = await zoho.fetchDocuments('600000001', { baseCurrency: 'AED' });
  assert.deepEqual(fake.calls, ['/contacts', '/invoices', '/bills', '/creditnotes', '/vendorcredits']);
  assert.deepEqual(docs.credits.map(c => c.currencyRate), [1, 1]);
});

test('Zoho: with the organisation currency unknown, the lists\' rate-1 currencies stand in for it', async t => {
  const invoice = { invoice_id: '9', status: 'sent', date: '2026-09-01', total: 1, balance: 1, currency_code: 'AED', exchange_rate: 1 };
  const fake = fakeZoho({ invoices: [invoice], vendor_credits: [vendorCredit('1', 'AED'), vendorCredit('2', 'USD')] },
    { 2: { exchange_rate: 3.6725 } });
  t.after(fake.restore);
  const docs = await zoho.fetchDocuments('600000001', {});
  assert.deepEqual(fake.calls.filter(c => c.startsWith('/vendorcredits/')), ['/vendorcredits/2']);
  assert.deepEqual(docs.credits.map(c => c.currencyRate), [1, 1 / 3.6725]);

  // No hint at all: every credit with a currency has its rate read (it cannot be told apart from the base).
  const none = fakeZoho({ vendor_credits: [vendorCredit('1', 'AED'), vendorCredit('2', 'USD')] }, { 1: { exchange_rate: 1 }, 2: { exchange_rate: 3.6725 } });
  try {
    const unknown = await zoho.fetchDocuments('600000001', {});
    assert.deepEqual(none.calls.filter(c => c.startsWith('/vendorcredits/')), ['/vendorcredits/1', '/vendorcredits/2']);
    assert.deepEqual(unknown.credits.map(c => c.currencyRate), [1, 1 / 3.6725]);
  } finally { none.restore(); }
});

test('Zoho: a failed vendor credit read leaves it with no rate and the sync carries on; a refused sign-in still stops it', async t => {
  const logged = [];
  t.mock.method(console, 'log', message => logged.push(String(message)));
  const fake = fakeZoho({ vendor_credits: [vendorCredit('1', 'USD'), vendorCredit('2', 'EUR'), vendorCredit('3', 'GBP')] },
    { 1: new Error('Zoho Books /vendorcredits/1 failed: 404 not found'), 2: { exchange_rate: 'n/a' }, 3: { exchange_rate: 4.757 } });
  try {
    const docs = await zoho.fetchDocuments('600000001', { baseCurrency: 'AED' });
    assert.deepEqual(docs.credits.map(c => c.currencyRate), [null, null, 1 / 4.757], 'failed and garbage rates are null, never 1');
    assert.ok(logged.some(line => line.includes('/vendorcredits/1 failed')), 'the failure is logged');
  } finally { fake.restore(); }

  const auth = fakeZoho({ vendor_credits: [vendorCredit('1', 'USD')] }, { 1: Object.assign(new Error('refused'), { authFailure: true }) });
  try {
    await assert.rejects(zoho.fetchDocuments('600000001', { baseCurrency: 'AED' }), /refused/);
  } finally { auth.restore(); }

  // After the daily call limit, the remaining reads are skipped instead of each failing in turn.
  const limit = fakeZoho({ vendor_credits: [vendorCredit('1', 'USD'), vendorCredit('2', 'USD')] },
    { 1: Object.assign(new Error('daily API limit'), { dailyLimit: true }), 2: { exchange_rate: 3.6725 } });
  try {
    const docs = await zoho.fetchDocuments('600000001', { baseCurrency: 'AED' });
    assert.deepEqual(limit.calls.filter(c => c.startsWith('/vendorcredits/')), ['/vendorcredits/1']);
    assert.deepEqual(docs.credits.map(c => c.currencyRate), [null, null]);
  } finally { limit.restore(); }
});

// ===================== the shared checks =====================

const TODAY = '2026-11-10T12:00:00.000Z';
const period = () => resolvePeriod({ type: 'all_transactions' }, { asOf: '2026-11-10' });
const customer = { contactID: 'c1', name: 'Alpha Trading' };
const supplier = { contactID: 'c2', name: 'Beta Supplies' };
// Zoho-mapped documents, as fetchDocuments hands them over (USD 3.6725, GBP 4.757 and EUR 4.0 AED per unit).
const zohoInvoice = (id, currency, rate, amount, extra = {}) => zoho.mapInvoice({ invoice_id: id, invoice_number: id.toUpperCase(),
  status: 'overdue', date: '2026-08-01', due_date: '2026-08-31', total: amount, balance: amount,
  customer_id: 'c1', customer_name: 'Alpha Trading', currency_code: currency, exchange_rate: rate, ...extra });
const zohoBill = (id, currency, rate, amount, extra = {}) => zoho.mapBill({ bill_id: id, bill_number: id.toUpperCase(),
  status: 'overdue', date: '2026-08-01', due_date: '2026-08-31', total: amount, balance: amount,
  vendor_id: 'c2', vendor_name: 'Beta Supplies', currency_code: currency, exchange_rate: rate, has_attachment: true, ...extra });

function aedClientDocuments() {
  const invoices = [
    zohoInvoice('i-usd', 'USD', 3.6725, 1000),
    zohoInvoice('i-gbp', 'GBP', 4.757, 200),
    zohoInvoice('i-aed', 'AED', 1, 500),
    zohoInvoice('i-eur', 'EUR', undefined, 300), // no rate on the document
    zohoInvoice('i-draft', 'USD', 3.6725, 100, { status: 'draft', date: '2026-11-01', due_date: '2026-11-30' }),
  ];
  const bills = [
    zohoBill('b-usd', 'USD', 3.6725, 2000),
    zohoBill('b-aed', 'AED', 1, 100),
    zohoBill('b-draft', 'AED', 1, 30, { status: 'draft', date: '2026-11-02', due_date: '2026-11-30' }),
  ];
  const salesCredit = zoho.mapSalesCredit({ creditnote_id: 's-gbp', creditnote_number: 'CN-1', status: 'open', date: '2026-08-01',
    total: 50, balance: 50, customer_id: 'c1', customer_name: 'Alpha Trading', currency_code: 'GBP', exchange_rate: 4.757 });
  const vendorCreditUsd = { ...zoho.mapVendorCredit({ vendor_credit_id: 'p-usd', vendor_credit_number: 'DN-1', status: 'open', date: '2026-08-01',
    total: 10, balance: 10, vendor_id: 'c2', vendor_name: 'Beta Supplies', currency_code: 'USD' }), currencyRate: 1 / 3.6725 };
  // A vendor credit whose one-credit read failed: no rate.
  const vendorCreditNoRate = zoho.mapVendorCredit({ vendor_credit_id: 'p-eur', vendor_credit_number: 'DN-2', status: 'open', date: '2026-08-01',
    total: 40, balance: 40, vendor_id: 'c2', vendor_name: 'Beta Supplies', currency_code: 'EUR' });
  const contacts = [{ ...customer, contactStatus: 'ACTIVE' }, { ...supplier, contactStatus: 'ACTIVE' }];
  return { invoices: [...invoices, ...bills], credits: [salesCredit, vendorCreditUsd, vendorCreditNoRate], contacts };
}

const issuesOf = (orgId, runId) => Object.fromEntries(getDb().prepare(
  'SELECT check_type, count, potential_value_gbp FROM issues WHERE org_id = ? AND run_id = ?'
).all(orgId, runId).map(row => [row.check_type, row]));
const rowsOf = (orgId, runId, checkType) => getDb().prepare(
  'SELECT detail_json, potential_value_gbp FROM issue_findings WHERE org_id = ? AND run_id = ? AND check_type = ? ORDER BY id'
).all(orgId, runId, checkType).map(row => ({ ...JSON.parse(row.detail_json), storedValue: row.potential_value_gbp }));

async function run(t, orgId, runId, docs, extra = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(TODAY) });
  getDb();
  return runLedgerChecks({
    org: { id: orgId, name: 'Made Up FZ LLC' }, runId, period: period(), invoices: docs.invoices, contacts: docs.contacts,
    credits: docs.credits, options: {}, ledger: ZOHO_LEDGER, saveOrganisation: async () => {}, baseCurrency: 'AED', ...extra,
  });
}

test('an AED client mixing AED, USD and GBP documents: every total is the hand-worked converted sum', async t => {
  const result = await run(t, 951, 9951, aedClientDocuments());
  const issues = issuesOf(951, 9951);

  // Old Unpaid Invoices: USD 1,000 x 3.6725 = 3,672.50; GBP 200 x 4.757 = 951.40; AED 500 = 500.00;
  // EUR 300 has no rate, so it is listed and counted but not in the total. 3,672.50 + 951.40 + 500.00 = 5,123.90.
  assert.equal(issues.old_unpaid_invoices.count, 4, 'the EUR invoice is still counted');
  assert.equal(round2(issues.old_unpaid_invoices.potential_value_gbp), 5123.90);
  // Old Unpaid Bills: USD 2,000 x 3.6725 = 7,345.00; AED 100 = 100.00. 7,345.00 + 100.00 = 7,445.00.
  assert.equal(issues.old_unpaid_bills.count, 2);
  assert.equal(round2(issues.old_unpaid_bills.potential_value_gbp), 7445.00);
  // Old Sales Credits: GBP 50 x 4.757 = 237.85.
  assert.equal(round2(issues.old_sales_credits.potential_value_gbp), 237.85);
  // Old Purchase Credits: USD 10 x 3.6725 = 36.725, rounded half-up per document to 36.73; the EUR 40 credit has no rate.
  assert.equal(issues.old_purchase_credits.count, 2);
  assert.equal(issues.old_purchase_credits.potential_value_gbp, 36.73);
  // Unapproved: draft invoice USD 100 x 3.6725 = 367.25; draft bill AED 30 = 30.00.
  assert.equal(round2(issues.unapproved_invoices.potential_value_gbp), 367.25);
  assert.equal(round2(issues.unapproved_bills.potential_value_gbp), 30.00);
  // Headline: 5,123.90 + 7,445.00 + 237.85 + 36.73 + 367.25 + 30.00 = 13,240.73.
  assert.equal(round2(result.totalPotentialErrors), 13240.73);

  // Each row keeps its own currency and figure, with the converted figure beside it.
  const invoiceRows = Object.fromEntries(rowsOf(951, 9951, 'old_unpaid_invoices').map(row => [row.id, row]));
  assert.equal(invoiceRows['i-usd'].currency, 'USD');
  assert.equal(invoiceRows['i-usd'].amountDue, 1000, 'the original USD figure is kept');
  assert.equal(round2(invoiceRows['i-usd'].baseAmount), 3672.50);
  assert.equal(round2(invoiceRows['i-usd'].storedValue), 3672.50, 'the finding\'s own share of the total is the converted figure');
  assert.equal(round2(invoiceRows['i-gbp'].storedValue), 951.40);
  assert.deepEqual(Object.keys(invoiceRows['i-aed']).filter(k => !['finding_key', 'storedValue'].includes(k)),
    ['id', 'number', 'contact', 'date', 'dueDate', 'amountDue'], 'a row in the client\'s currency is exactly as before');
  assert.equal(invoiceRows['i-aed'].storedValue, 500);
  assert.equal(invoiceRows['i-eur'].noExchangeRate, true);
  assert.equal(invoiceRows['i-eur'].currency, 'EUR');
  assert.equal(invoiceRows['i-eur'].amountDue, 300);
  assert.ok(!('baseAmount' in invoiceRows['i-eur']));
  assert.equal(invoiceRows['i-eur'].storedValue, 0, 'no rate: nothing of it in the total');
  const purchaseRows = Object.fromEntries(rowsOf(951, 9951, 'old_purchase_credits').map(row => [row.id, row]));
  assert.equal(purchaseRows['vc-p-eur'].noExchangeRate, true);
  assert.equal(purchaseRows['vc-p-usd'].baseAmount, 36.73);
});

test('turnover is converted, and is "not available" while a sale has no rate', async t => {
  const docs = aedClientDocuments();
  const withNet = docs.invoices.map(doc => ({ ...doc, subTotal: doc.total }));
  await run(t, 952, 9952, { ...docs, invoices: withNet.filter(doc => doc.invoiceID !== 'i-eur'),
    credits: docs.credits.map(c => ({ ...c, subTotal: c.total })) });
  const counts = getDb().prepare('SELECT turnover FROM transaction_counts WHERE org_id = ? AND run_id = ?').get(952, 9952);
  // Approved sales: 3,672.50 (USD 1,000) + 951.40 (GBP 200) + 500.00 (AED) = 5,123.90, less the GBP 50 credit 237.85 = 4,886.05.
  assert.equal(round2(counts.turnover), 4886.05);

  t.mock.timers.reset();
  await run(t, 953, 9953, { ...docs, invoices: withNet, credits: docs.credits.map(c => ({ ...c, subTotal: c.total })) });
  assert.equal(getDb().prepare('SELECT turnover FROM transaction_counts WHERE org_id = ? AND run_id = ?').get(953, 9953).turnover, null,
    'the EUR sale with no rate makes turnover unknown rather than wrong');
});

test('duplicate bills in another currency: the group\'s exposure is converted and the row says so', async t => {
  const docs = {
    invoices: [
      zohoBill('d-1', 'USD', 3.6725, 250, { date: '2026-11-01', due_date: '2026-11-30', status: 'open' }),
      zohoBill('d-2', 'USD', 3.6725, 250, { date: '2026-11-02', due_date: '2026-11-30', status: 'open' }),
    ],
    credits: [], contacts: [{ ...supplier, contactStatus: 'ACTIVE' }],
  };
  await run(t, 954, 9954, docs);
  // USD 250 x 3.6725 = 918.125, rounded half-up to 918.13, counted once for the group.
  assert.equal(issuesOf(954, 9954).duplicate_bills.potential_value_gbp, 918.13);
  const [group] = rowsOf(954, 9954, 'duplicate_bills');
  assert.equal(group.currency, 'USD');
  assert.equal(group.amount, 250);
  assert.equal(group.baseAmount, 918.13);
});

test('QuickBooks: its currencyRate goes through the same conversion', async t => {
  const names = new Map([['c1', 'Alpha Trading']]);
  const invoice = qbo.mapInvoice({ Id: 'q1', DocNumber: 'Q-1', TxnDate: '2026-08-01', DueDate: '2026-08-31', TotalAmt: 100, Balance: 100,
    CustomerRef: { value: 'c1' }, CurrencyRef: { value: 'EUR' }, ExchangeRate: 0.8, Line: [] }, names);
  assert.equal(invoice.currencyRate, 1.25);
  await run(t, 955, 9955, { invoices: [invoice], credits: [], contacts: [] }, { ledger: qbo.ledger, baseCurrency: 'GBP' });
  // EUR 100 x 0.8 = 80.00 in pounds.
  assert.equal(round2(issuesOf(955, 9955).old_unpaid_invoices.potential_value_gbp), 80);
  const [row] = rowsOf(955, 9955, 'old_unpaid_invoices');
  assert.equal(row.currency, 'EUR');
  assert.equal(round2(row.baseAmount), 80);
});

test('documents all in the client\'s currency give exactly the rows and totals they always did', async t => {
  // The same documents with Zoho's rate 1, and with no currency or rate at all (FreeAgent/QuickBooks shape).
  const plain = () => {
    const docs = aedClientDocuments();
    const strip = doc => { const { currencyRate, ...rest } = doc; return { ...rest, currencyCode: null }; };
    return { ...docs, invoices: docs.invoices.map(strip), credits: docs.credits.map(strip) };
  };
  const sameCurrency = () => {
    const docs = plain();
    const aed = doc => ({ ...doc, currencyCode: 'AED', currencyRate: 1 });
    return { ...docs, invoices: docs.invoices.map(aed), credits: docs.credits.map(aed) };
  };
  await run(t, 956, 9956, plain());
  t.mock.timers.reset();
  await run(t, 957, 9957, sameCurrency());
  const strip = rows => rows.map(({ storedValue, ...row }) => ({ row, storedValue }));
  for (const check of ['old_unpaid_invoices', 'old_unpaid_bills', 'old_sales_credits', 'old_purchase_credits', 'unapproved_invoices',
    'unapproved_bills', 'undocumented_bills', 'duplicate_bills']) {
    const before = strip(rowsOf(956, 9956, check));
    assert.deepEqual(strip(rowsOf(957, 9957, check)), before, check);
    for (const { row } of before) {
      for (const key of ['currency', 'baseAmount', 'noExchangeRate', 'potentialValue']) assert.ok(!(key in row), `${check}: no ${key}`);
    }
  }
  const a = issuesOf(956, 9956);
  const b = issuesOf(957, 9957);
  assert.deepEqual(b, a);
  // The raw sums, unconverted: 1,000 + 200 + 500 + 300 = 2,000.
  assert.equal(a.old_unpaid_invoices.potential_value_gbp, 2000);
  assert.equal(a.old_purchase_credits.potential_value_gbp, 50);
});

test('duplicates: an AED bill and a USD bill of the same figure are not a duplicate; same-currency groups are as before', async t => {
  const bill = (id, currency, rate, date) => zohoBill(id, currency, rate, 100, { date, due_date: '2026-11-30', status: 'open' });
  const docs = {
    invoices: [bill('m-aed', 'AED', 1, '2026-11-01'), bill('m-usd', 'USD', 3.6725, '2026-11-03')],
    credits: [], contacts: [{ ...supplier, contactStatus: 'ACTIVE' }],
  };
  await run(t, 960, 9960, docs);
  // AED 100 and USD 100 (= AED 367.25) are different amounts in the client's currency: no group.
  assert.equal(issuesOf(960, 9960).duplicate_bills.count, 0);
  assert.equal(issuesOf(960, 9960).duplicate_bills.potential_value_gbp, 0);

  // Two AED 100 bills and a USD 100 bill: one group, of the two AED bills only, in the client's currency.
  t.mock.timers.reset();
  await run(t, 961, 9961, { ...docs, invoices: [...docs.invoices, bill('m-aed2', 'AED', 1, '2026-11-02')] });
  assert.equal(issuesOf(961, 9961).duplicate_bills.count, 1);
  assert.equal(issuesOf(961, 9961).duplicate_bills.potential_value_gbp, 100);
  const [group] = rowsOf(961, 9961, 'duplicate_bills');
  assert.deepEqual(group.documentIds, ['bill-m-aed', 'bill-m-aed2']);
  assert.ok(!('currency' in group), 'an AED group carries no currency, so its nested figures read "AED"');
});

test('converted figures are rounded per document, so a total is the sum of the figures its rows show', async t => {
  const usdCredit = id => ({ ...zoho.mapVendorCredit({ vendor_credit_id: id, vendor_credit_number: id, status: 'open', date: '2026-08-01',
    total: 10, balance: 10, vendor_id: 'c2', vendor_name: 'Beta Supplies', currency_code: 'USD' }), currencyRate: 1 / 3.6725 });
  const docs = {
    invoices: [zohoBill('r-eur', 'EUR', 4.0123, 111.11)],
    credits: [usdCredit('r1'), usdCredit('r2')], contacts: [],
  };
  await run(t, 962, 9962, docs);
  // Each USD 10 credit: 10 x 3.6725 = 36.725 -> 36.73 (half up). Two rows: 36.73 + 36.73 = 73.46.
  const credits = rowsOf(962, 9962, 'old_purchase_credits');
  assert.deepEqual(credits.map(row => row.baseAmount), [36.73, 36.73]);
  assert.equal(issuesOf(962, 9962).old_purchase_credits.potential_value_gbp, 73.46);
  // EUR 111.11 x 4.0123 = 445.806653 -> 445.81.
  assert.equal(rowsOf(962, 9962, 'old_unpaid_bills')[0].baseAmount, 445.81);
  assert.equal(issuesOf(962, 9962).old_unpaid_bills.potential_value_gbp, 445.81);
});

test('FreeAgent (no exchange rate mapped, UK clients): a non-GBP document is counted as it stands, as before', async t => {
  const plainDoc = (id, currencyCode, amount) => ({ invoiceID: id, invoiceNumber: id.toUpperCase(), type: 'ACCREC', status: 'AUTHORISED',
    date: '2026-08-01', dueDate: '2026-08-31', total: amount, subTotal: amount, amountDue: amount, contact: customer, currencyCode });
  await run(t, 963, 9963, { invoices: [plainDoc('f-gbp', 'GBP', 500), plainDoc('f-eur', 'EUR', 300)], credits: [], contacts: [] },
    { ledger: FREEAGENT_LEDGER, baseCurrency: undefined });
  // 500 + 300 = 800, exactly as before conversion existed.
  assert.equal(issuesOf(963, 9963).old_unpaid_invoices.potential_value_gbp, 800);
  const rows = Object.fromEntries(rowsOf(963, 9963, 'old_unpaid_invoices').map(row => [row.id, row]));
  assert.equal(rows['f-eur'].currency, 'EUR');
  for (const key of ['baseAmount', 'noExchangeRate', 'potentialValue']) assert.ok(!(key in rows['f-eur']), `no ${key}`);
  assert.ok(!('currency' in rows['f-gbp']));
  assert.equal(getDb().prepare('SELECT turnover FROM transaction_counts WHERE org_id = ? AND run_id = ?').get(963, 9963).turnover, 800,
    'turnover is still worked out');
});

test('a cache-only re-run before the client\'s currency is stored leaves the totals as they were, never zero', async t => {
  // Documents cached before conversion existed (no currencyRate), and no stored currency (baseCurrency null).
  const strip = doc => { const { currencyRate, ...rest } = doc; return rest; };
  const docs = {
    invoices: [strip(zohoInvoice('o-inv', 'AED', 1, 500)), strip(zohoBill('o-bill', 'AED', 1, 700))],
    credits: [], contacts: [],
  };
  await run(t, 964, 9964, docs, { baseCurrency: null });
  const issues = issuesOf(964, 9964);
  assert.equal(issues.old_unpaid_invoices.count, 1);
  assert.equal(issues.old_unpaid_invoices.potential_value_gbp, 500);
  assert.equal(issues.old_unpaid_bills.potential_value_gbp, 700);
  for (const check of ['old_unpaid_invoices', 'old_unpaid_bills']) {
    for (const row of rowsOf(964, 9964, check)) {
      for (const key of ['baseAmount', 'noExchangeRate', 'potentialValue']) assert.ok(!(key in row), `${check}: no ${key}`);
    }
  }
});

test('Zoho: no rate is read for a foreign vendor credit that can never reach a total (closed, void, draft or used up)', async t => {
  const credit = (id, status, balance) => ({ ...vendorCredit(id, 'USD'), status, balance });
  const fake = fakeZoho({ vendor_credits: [credit('1', 'closed', 0), credit('2', 'void', 100), credit('3', 'open', 0),
    credit('4', 'draft', 100), credit('5', 'open', 100)] }, { 5: { exchange_rate: 3.6725 } });
  t.after(fake.restore);
  const docs = await zoho.fetchDocuments('600000001', { baseCurrency: 'AED' });
  assert.deepEqual(fake.calls.filter(c => c.startsWith('/vendorcredits/')), ['/vendorcredits/5'], 'only the open credit with a balance');
  assert.deepEqual(docs.credits.map(c => c.currencyRate), [null, null, null, null, 1 / 3.6725]);
});

// ===================== the check page =====================

const VIEWS = path.join(__dirname, '../src/views');
const globals = { currencyPrefix, formatMoney, basePath: '/akrio-verify', csrfToken: 'token', practiceName: 'P', cssVersion: 't',
  staffName: null, staffRole: null, isStaffManager: false, canAccessSettings: false };
function renderCheckDetail(items, extra = {}) {
  return ejs.renderFile(path.join(VIEWS, 'checkDetail.ejs'), {
    ...globals, org: { name: 'Made Up FZ LLC', id: 1, freeagent_company_id: 'zoho-1' },
    issue: { count: items.length, potential_value_gbp: 4172.5, period_checked: 'since_lock_date', synced_at: '2026-11-24' },
    def: { type: 'old_unpaid_invoices', label: 'Old Unpaid Invoices', importance: 'high' },
    items, pagination: { page: 1, totalPages: 1, total: items.length, items }, summary: { active: items.length, dismissed: 0, ignored: 0, ok: 0 },
    status: 'active', contact: '', checkType: 'old_unpaid_invoices', checkDescriptions: {}, groupSupplierTransactions, ...extra,
  });
}
const row = (key, extra) => ({ finding_key: key, number: key.toUpperCase(), contact: 'Customer', date: '2026-08-01', review_state: 'active', xero_links: [], ...extra });

test('check page: a converted row shows both figures; a row with no rate says it is not in the totals', async () => {
  const items = [
    row('k1', { amountDue: 1000, currency: 'USD', baseAmount: 3672.5, potentialValue: 3672.5 }),
    row('k2', { amountDue: 300, currency: 'EUR', noExchangeRate: true, potentialValue: 0 }),
    row('k3', { amountDue: 500 }),
  ];
  const html = await renderCheckDetail(items, { clientCurrency: 'AED' });
  assert.ok(html.includes('USD 1,000.00 = AED 3,672.50'), 'both figures on the converted row');
  assert.ok(html.includes('EUR 300.00 <span style="font-size:0.7rem;color:#7C8FAC;">(no exchange rate - not included in totals)</span>'));
  assert.ok(html.includes('AED 500.00'));
  assert.ok(!html.includes('not converted'), 'the old wording is gone for these rows');
  assert.ok(!/>\s*Base Amount\s*</.test(html) && !/>\s*No Exchange Rate\s*</.test(html), 'no extra columns');
  assert.ok(html.includes('the totals use the converted amounts'));
  assert.ok(html.includes('not included in the totals'));
});

test('check page: rows in the client\'s currency, and Xero\'s foreign rows, render exactly as before', async () => {
  const plain = [row('k1', { amountDue: 500 }), row('k2', { amountDue: 1200.5 })];
  const html = await renderCheckDetail(plain);
  assert.ok(html.includes('£500.00') && html.includes('£1,200.50'));
  assert.ok(!html.includes(' = £'), 'no conversion text');
  assert.ok(!html.includes('check-note">Some documents'));
  // A Xero row in another currency carries currency and potentialValue but no baseAmount: unchanged wording.
  const xero = [row('k1', { amountDue: 500, currency: 'USD', potentialValue: 400 }), row('k2', { amountDue: 1200 })];
  const xeroHtml = await renderCheckDetail(xero);
  assert.ok(xeroHtml.includes('USD 500.00 <span style="font-size:0.7rem;color:#7C8FAC;">(not converted)</span>'));
  assert.ok(xeroHtml.includes('Their amounts are shown in that currency, not converted.'));
  assert.ok(!xeroHtml.includes('= £'));
});
