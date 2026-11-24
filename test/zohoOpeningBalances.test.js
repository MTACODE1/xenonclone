// Zoho Books opening balances: a client that started in Zoho with balances brought forward has a hidden
// "Customer opening balance" / "Vendor opening balance" document per contact that the invoice and bill lists
// never return. The contact list's outstanding_*_bcy totals pick out the contacts the lists do not explain; only
// those cost calls (GET /contacts/{id}, then /invoices/{id} or /bills/{id}). The documents count in Old Unpaid
// Invoices/Bills and are left out of duplicates, unapproved, undocumented bills, turnover and the counts.
// Throwaway SQLite; MySQL and Zoho are stand-ins. Nothing reaches a real ledger or database. Made-up data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akrio-zoho-ob-'));
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

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const ORG = '600000001';
const LISTS = ['/contacts', '/invoices', '/bills', '/creditnotes', '/vendorcredits'];

// A stand-in for client.apiGet: the lists, and the one-document reads, recorded in order.
// details: path -> answer body (or an Error to throw).
function fakeZoho(lists, details = {}) {
  const calls = [];
  const original = zohoClient.apiGet;
  zohoClient.apiGet = async (externalId, pathName) => {
    calls.push(pathName);
    const key = { '/contacts': 'contacts', '/invoices': 'invoices', '/bills': 'bills', '/creditnotes': 'creditnotes', '/vendorcredits': 'vendor_credits' }[pathName];
    if (key) return { code: 0, [key]: lists[key] || [], page_context: { has_more_page: false } };
    const answer = details[pathName];
    if (answer instanceof Error) throw answer;
    if (!answer) throw Object.assign(new Error(`Zoho Books ${pathName} failed: 404 The requested resource does not exist.`), { status: 404 });
    return { code: 0, ...answer };
  };
  return { calls, restore: () => { zohoClient.apiGet = original; } };
}

const contactRow = (id, name, receivable, payable, type = 'customer') => ({
  contact_id: id, contact_name: name, contact_type: type, status: 'active',
  outstanding_receivable_amount: receivable, outstanding_receivable_amount_bcy: receivable,
  outstanding_payable_amount: payable, outstanding_payable_amount_bcy: payable,
});
const invoiceRow = (id, customerId, name, amount, extra = {}) => ({
  invoice_id: id, invoice_number: `INV-${id}`, status: 'overdue', date: '2026-07-01', due_date: '2026-07-31',
  total: amount, balance: amount, customer_id: customerId, customer_name: name, currency_code: 'AED', exchange_rate: 1, ...extra,
});
const billRow = (id, vendorId, name, amount, extra = {}) => ({
  bill_id: id, bill_number: `BILL-${id}`, status: 'overdue', date: '2026-07-01', due_date: '2026-07-31',
  total: amount, balance: amount, vendor_id: vendorId, vendor_name: name, currency_code: 'AED', exchange_rate: 1, has_attachment: true, ...extra,
});
// Opening-balance documents as GET /invoices/{id} and GET /bills/{id} answer them.
const obInvoice = (id, customerId, name, total, balance = total, extra = {}) => ({
  invoice_id: id, type: 'customer_ob_invoice', invoice_number: 'Customer opening balance', status: 'overdue',
  date: '2026-04-30', due_date: '2026-04-30', total, balance, customer_id: customerId, customer_name: name,
  currency_code: 'AED', exchange_rate: 1, ...extra,
});
const obBill = (id, vendorId, name, total, balance = total, extra = {}) => ({
  bill_id: id, bill_number: 'Vendor opening balance', status: 'overdue', date: '2026-04-30', due_date: '2026-04-30',
  total, balance, vendor_id: vendorId, vendor_name: name, currency_code: 'AED', exchange_rate: 1, ...extra,
});
const contactDetail = (id, entries, { receivable = null, payable = null } = {}) => ({
  contact: {
    contact_id: id,
    opening_balances: entries.map(([obId, amount]) => ({ opening_balance_amount: amount, opening_balance_amount_bcy: amount, ob_invoice_id: obId, exchange_rate: 1 })),
    ...(receivable == null ? {} : { outstanding_ob_receivable_amount: receivable }),
    ...(payable == null ? {} : { outstanding_ob_payable_amount: payable }),
  },
});

// ===================== which contacts are read =====================

test('no call beyond the lists when every contact\'s unpaid total matches its listed documents (converted)', async t => {
  const fake = fakeZoho({
    contacts: [
      // AED 1,000 + USD 100 x 3.6725 = 1,367.25 (USD rounded per document as the checks do)
      contactRow('c1', 'Alpha Trading', 1367.25, 0),
      contactRow('c2', 'Beta Supplies', 0, 500, 'vendor'),
      contactRow('c3', 'Gamma Retail', 0, 0),
      contactRow('c4', 'Delta Services', 0.005, 0), // within the 0.01 tolerance
    ],
    invoices: [
      invoiceRow('i1', 'c1', 'Alpha Trading', 1000),
      invoiceRow('i2', 'c1', 'Alpha Trading', 100, { currency_code: 'USD', exchange_rate: 3.6725 }),
      invoiceRow('i3', 'c1', 'Alpha Trading', 50, { status: 'paid', balance: 0 }),
    ],
    bills: [billRow('b1', 'c2', 'Beta Supplies', 500), billRow('b2', 'c2', 'Beta Supplies', 70, { status: 'draft' })],
  });
  t.after(fake.restore);
  const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED' });
  assert.deepEqual(fake.calls, LISTS, 'only the five lists');
  assert.equal(docs.invoices.length, 3);
  assert.equal(docs.bills.length, 2);
  assert.ok(docs.invoices.every(doc => !doc.isOpeningBalance));
});

test('candidates: only contacts with a gap, per side; an unconvertible open document makes its side a candidate', () => {
  const invoices = [
    zoho.mapInvoice(invoiceRow('i1', 'c1', 'A', 1000)),
    zoho.mapInvoice(invoiceRow('i2', 'c5', 'E', 10, { currency_code: 'EUR', exchange_rate: undefined })),
    zoho.mapInvoice(invoiceRow('i3', 'c6', 'F', 100, { status: 'draft' })), // a draft is not unpaid in Zoho's total
  ];
  const bills = [zoho.mapBill(billRow('b1', 'c2', 'B', 300))];
  const candidates = zoho.openingBalanceCandidates([
    contactRow('c1', 'A', 1000, 0),        // matches
    contactRow('c2', 'B', 0, 1500),        // supplier gap 1,200
    contactRow('c3', 'C', 400, 250),       // both sides, nothing listed
    contactRow('c5', 'E', 36.73, 0),       // EUR invoice with no rate: cannot be compared
    contactRow('c6', 'F', 100, 0),         // only a draft listed: gap 100
    { contact_id: 'c7', contact_name: 'G' }, // no totals on the row
  ], invoices, bills, { baseCurrency: 'AED' });
  assert.deepEqual(candidates.map(c => [c.contactId, c.customer, c.supplier]), [
    ['c2', false, true], ['c3', true, true], ['c5', true, false], ['c6', true, false],
  ]);
});

// ===================== reading and mapping =====================

function gapClient() {
  const lists = {
    contacts: [
      contactRow('c1', 'Alpha Trading', 5000, 0),                  // customer OB 4,000 (1,000 listed)
      contactRow('c2', 'Beta Supplies', 0, 1200, 'vendor'),         // vendor OB 3,000, partly paid: 1,200 left
      contactRow('c3', 'Gamma Retail', 367.25, 50),                 // customer OB USD 100 and vendor OB AED 50
      contactRow('c4', 'Delta Services', 800, 0),                   // listed only: matches
    ],
    invoices: [invoiceRow('i1', 'c1', 'Alpha Trading', 1000, { date: '2026-04-30', total: 4000, balance: 1000 }), invoiceRow('i4', 'c4', 'Delta Services', 800)],
    bills: [],
  };
  const details = {
    '/contacts/c1': contactDetail('c1', [['ob-1', 4000]], { receivable: 4000, payable: 0 }),
    '/invoices/ob-1': { invoice: obInvoice('ob-1', 'c1', 'Alpha Trading', 4000) },
    '/contacts/c2': contactDetail('c2', [['ob-2', 3000]], { receivable: 0, payable: 1200 }),
    '/bills/ob-2': { bill: obBill('ob-2', 'c2', 'Beta Supplies', 3000, 1200) },
    '/contacts/c3': contactDetail('c3', [['ob-3', 367.25], ['ob-4', 50]], { receivable: 367.25, payable: 50 }),
    '/invoices/ob-3': { invoice: obInvoice('ob-3', 'c3', 'Gamma Retail', 100, 100, { currency_code: 'USD', exchange_rate: 3.6725 }) },
    // ob-4 is the vendor side: /invoices/ob-4 is not found, /bills/ob-4 is
    '/bills/ob-4': { bill: obBill('ob-4', 'c3', 'Gamma Retail', 50) },
  };
  return { lists, details };
}

test('customer and supplier opening balances are read only for the contacts with a gap, and mapped', async t => {
  t.mock.method(console, 'log', () => {});
  const { lists, details } = gapClient();
  const fake = fakeZoho(lists, details);
  t.after(fake.restore);
  const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED' });
  assert.deepEqual(fake.calls.slice(LISTS.length), [
    '/contacts/c1', '/invoices/ob-1',
    '/contacts/c2', '/bills/ob-2',
    '/contacts/c3', '/invoices/ob-3', '/invoices/ob-4', '/bills/ob-4',
  ], 'c4 (no gap) costs nothing; a one-sided contact reads only its side');

  const ob = Object.fromEntries([...docs.invoices, ...docs.bills].filter(d => d.isOpeningBalance).map(d => [d.invoiceID, d]));
  assert.deepEqual(Object.keys(ob).sort(), ['bill-ob-2', 'bill-ob-4', 'ob-1', 'ob-3']);
  assert.equal(ob['ob-1'].type, 'ACCREC');
  assert.equal(ob['ob-1'].invoiceNumber, 'Customer opening balance');
  assert.equal(ob['ob-1'].status, 'AUTHORISED');
  assert.equal(ob['ob-1'].amountDue, 4000);
  assert.deepEqual(ob['ob-1'].contact, { contactID: 'c1', name: 'Alpha Trading' });
  assert.equal(ob['bill-ob-2'].type, 'ACCPAY');
  assert.equal(ob['bill-ob-2'].invoiceNumber, 'Vendor opening balance');
  assert.equal(ob['bill-ob-2'].total, 3000);
  assert.equal(ob['bill-ob-2'].amountDue, 1200, 'partly paid: what is left, not the total');
  assert.equal(ob['ob-3'].currencyCode, 'USD');
  assert.equal(ob['ob-3'].currencyRate, 1 / 3.6725);
  assert.equal(docs.invoices.filter(d => d.invoiceID === 'ob-1').length, 1);
});

test('nothing is added twice: an id the lists returned, or repeated, is not read again', async t => {
  t.mock.method(console, 'log', () => {});
  const fake = fakeZoho({
    contacts: [contactRow('c1', 'Alpha Trading', 5000, 0)],
    invoices: [invoiceRow('ob-0', 'c1', 'Alpha Trading', 1000)],
  }, {
    '/contacts/c1': contactDetail('c1', [['ob-0', 1000], ['ob-1', 4000], ['ob-1', 4000]]),
    '/invoices/ob-1': { invoice: obInvoice('ob-1', 'c1', 'Alpha Trading', 4000) },
  });
  t.after(fake.restore);
  const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED' });
  assert.deepEqual(fake.calls.slice(LISTS.length), ['/contacts/c1', '/invoices/ob-1']);
  assert.deepEqual(docs.invoices.map(d => d.invoiceID), ['ob-0', 'ob-1']);
});

test('a side Zoho says has no opening balance owed is not read', async t => {
  const fake = fakeZoho({ contacts: [contactRow('c1', 'Alpha Trading', 300, 0)] }, {
    '/contacts/c1': contactDetail('c1', [['ob-1', 300]], { receivable: 0, payable: 0 }),
  });
  t.after(fake.restore);
  const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED' });
  assert.deepEqual(fake.calls.slice(LISTS.length), ['/contacts/c1']);
  assert.equal(docs.invoices.length, 0);
});

test('errors: a failed read is logged and skipped, the daily limit stops further reads, a refused sign-in stops the sync', async t => {
  const logged = [];
  t.mock.method(console, 'log', message => logged.push(String(message)));
  const lists = { contacts: [contactRow('c1', 'Alpha Trading', 100, 0), contactRow('c2', 'Beta Supplies', 200, 0), contactRow('c3', 'Gamma Retail', 300, 0)] };

  const failing = fakeZoho(lists, {
    '/contacts/c1': new Error('Zoho Books /contacts/c1 failed: 500 something broke'),
    '/contacts/c2': contactDetail('c2', [['ob-2', 200]]),
    '/invoices/ob-2': { invoice: obInvoice('ob-2', 'c2', 'Beta Supplies', 200) },
    '/contacts/c3': contactDetail('c3', []),
  });
  try {
    const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED' });
    assert.deepEqual(docs.invoices.map(d => d.invoiceID), ['ob-2'], 'the others are still read');
    assert.ok(logged.some(line => line.includes('/contacts/c1 failed')));
  } finally { failing.restore(); }

  const limit = fakeZoho(lists, {
    '/contacts/c1': contactDetail('c1', [['ob-1', 100]]),
    '/invoices/ob-1': Object.assign(new Error('daily API limit'), { dailyLimit: true }),
    '/contacts/c2': contactDetail('c2', [['ob-2', 200]]),
  });
  try {
    const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED' });
    assert.deepEqual(limit.calls.slice(LISTS.length), ['/contacts/c1', '/invoices/ob-1'], 'no read after the limit');
    assert.equal(docs.invoices.length, 0, 'the sync still returns the lists');
  } finally { limit.restore(); }

  for (const flag of ['authFailure', 'retryLater', 'configurationError']) {
    const fatal = fakeZoho(lists, { '/contacts/c1': Object.assign(new Error(`refused ${flag}`), { [flag]: true }) });
    try {
      await assert.rejects(zoho.fetchDocuments(ORG, { baseCurrency: 'AED' }), new RegExp(`refused ${flag}`));
    } finally { fatal.restore(); }
  }
});

// ===================== the checks =====================

const TODAY = '2026-11-10T12:00:00.000Z';
const rowsOf = (orgId, runId, checkType) => getDb().prepare(
  'SELECT detail_json FROM issue_findings WHERE org_id = ? AND run_id = ? AND check_type = ? ORDER BY id'
).all(orgId, runId, checkType).map(row => JSON.parse(row.detail_json));
const issuesOf = (orgId, runId) => Object.fromEntries(getDb().prepare(
  'SELECT check_type, count, potential_value_gbp FROM issues WHERE org_id = ? AND run_id = ?'
).all(orgId, runId).map(row => [row.check_type, { ...row, detail: rowsOf(orgId, runId, row.check_type) }]));

async function run(t, orgId, runId, docs) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(TODAY) });
  getDb();
  return runLedgerChecks({
    org: { id: orgId, name: 'Made Up FZ LLC' }, runId, period: resolvePeriod({ type: 'all_transactions' }, { asOf: '2026-11-10' }),
    invoices: [...docs.invoices, ...docs.bills], contacts: docs.contacts, credits: [], options: {},
    ledger: zoho.ledger, saveOrganisation: async () => {}, baseCurrency: 'AED',
  });
}

test('Old Unpaid Invoices/Bills count the opening balances in the client\'s currency', async t => {
  t.mock.method(console, 'log', () => {});
  const { lists, details } = gapClient();
  const fake = fakeZoho(lists, details);
  let docs;
  try { docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED' }); } finally { fake.restore(); }
  await run(t, 961, 9961, docs);
  const issues = issuesOf(961, 9961);

  // Invoices: listed i1 1,000 + listed i4 800 + OB 4,000 + OB USD 100 x 3.6725 = 367.25 -> 6,167.25.
  assert.equal(issues.old_unpaid_invoices.count, 4);
  assert.equal(issues.old_unpaid_invoices.potential_value_gbp, 6167.25);
  const ob1 = issues.old_unpaid_invoices.detail.find(row => row.id === 'ob-1');
  assert.equal(ob1.number, 'Customer opening balance');
  assert.equal(ob1.openingBalance, true);
  assert.equal(ob1.amountDue, 4000);
  const ob3 = issues.old_unpaid_invoices.detail.find(row => row.id === 'ob-3');
  assert.equal(ob3.currency, 'USD');
  assert.equal(ob3.baseAmount, 367.25);
  const listed = issues.old_unpaid_invoices.detail.find(row => row.id === 'i4');
  assert.ok(!('openingBalance' in listed), 'a listed invoice\'s row is as before');

  // Bills: vendor OB 1,200 left of 3,000 + vendor OB 50 -> 1,250.
  assert.equal(issues.old_unpaid_bills.count, 2);
  assert.equal(issues.old_unpaid_bills.potential_value_gbp, 1250);
  assert.equal(issues.old_unpaid_bills.detail.find(row => row.id === 'bill-ob-2').amountDue, 1200);
});

test('opening balances are left out of duplicates, unapproved, undocumented bills, turnover and the counts', async t => {
  const contact = { contactID: 'c1', name: 'Alpha Trading' };
  const supplier = { contactID: 'c2', name: 'Beta Supplies' };
  // A listed invoice and an opening balance with the same contact, figure and date (and the same for bills, where
  // the opening balance has no attachment), all with a net figure except the opening balances, which have none.
  const listedInvoice = { ...zoho.mapInvoice(invoiceRow('i1', 'c1', 'Alpha Trading', 4000, { date: '2026-04-30' })), subTotal: 4000 };
  const obInv = { ...zoho.mapInvoice(obInvoice('ob-1', 'c1', 'Alpha Trading', 4000)), isOpeningBalance: true };
  const listedBill = zoho.mapBill(billRow('b1', 'c2', 'Beta Supplies', 3000, { date: '2026-04-30' }));
  const obB = { ...zoho.mapBill(obBill('ob-2', 'c2', 'Beta Supplies', 3000)), isOpeningBalance: true };
  const docs = {
    invoices: [listedInvoice, obInv], bills: [listedBill, obB],
    contacts: [{ ...contact, contactStatus: 'ACTIVE' }, { ...supplier, contactStatus: 'ACTIVE' }],
  };
  await run(t, 962, 9962, docs);
  const issues = issuesOf(962, 9962);
  assert.equal(issues.duplicate_invoices.count, 0);
  assert.equal(issues.duplicate_bills.count, 0);
  assert.equal(issues.undocumented_bills.count, 0, 'the vendor opening balance has no attachment and is not listed');
  assert.equal(issues.unapproved_invoices.count, 0);
  assert.equal(issues.old_unpaid_invoices.count, 2);
  assert.equal(issues.old_unpaid_bills.count, 2);
  const counts = getDb().prepare('SELECT turnover, customer_invoices, supplier_bills FROM transaction_counts WHERE org_id = ? AND run_id = ?').get(962, 9962);
  assert.equal(counts.turnover, 4000, 'only the listed invoice\'s net figure (the opening balance has none and is not a sale)');
  assert.equal(counts.customer_invoices, 1);
  assert.equal(counts.supplier_bills, 1);

  // Control: the same documents without the mark would be flagged (so the test above is meaningful).
  t.mock.timers.reset();
  const plain = doc => { const { isOpeningBalance, ...rest } = doc; return rest; };
  await run(t, 963, 9963, { ...docs, invoices: docs.invoices.map(plain), bills: docs.bills.map(plain) });
  const control = issuesOf(963, 9963);
  assert.equal(control.duplicate_invoices.count, 1);
  assert.equal(control.duplicate_bills.count, 1);
  assert.equal(control.undocumented_bills.count, 1);
  assert.equal(getDb().prepare('SELECT turnover FROM transaction_counts WHERE org_id = ? AND run_id = ?').get(963, 9963).turnover, null);
});

test('a draft opening balance (should Zoho ever give one) is not listed as unapproved', async t => {
  const draft = { ...zoho.mapInvoice(obInvoice('ob-9', 'c1', 'Alpha Trading', 10, 10, { status: 'draft', date: '2026-11-01' })), isOpeningBalance: true };
  await run(t, 964, 9964, { invoices: [draft], bills: [], contacts: [] });
  assert.equal(issuesOf(964, 9964).unapproved_invoices.count, 0);
});

// ===================== review fixes =====================

test('a vendor opening balance that /invoices/{id} answers for is not taken as a customer invoice', async t => {
  t.mock.method(console, 'log', () => {});
  // c1 is short on both sides; its only opening balance is the vendor one, and /invoices/v1 answers for it.
  const vendorAsInvoice = { invoice: { invoice_id: 'v1', type: 'vendor_ob_invoice', invoice_number: 'Vendor opening balance', status: 'overdue',
    date: '2026-04-30', due_date: '2026-04-30', total: 800, balance: 800, customer_id: 'c1', customer_name: 'Alpha Trading', currency_code: 'AED', exchange_rate: 1 } };
  const both = fakeZoho({ contacts: [contactRow('c1', 'Alpha Trading', 100, 800)] }, {
    '/contacts/c1': contactDetail('c1', [['v1', 800]]),
    '/invoices/v1': vendorAsInvoice,
    '/bills/v1': { bill: obBill('v1', 'c1', 'Alpha Trading', 800) },
  });
  try {
    const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED' });
    assert.deepEqual(both.calls.slice(LISTS.length), ['/contacts/c1', '/invoices/v1', '/bills/v1'], 'the bill read follows');
    assert.deepEqual(docs.invoices.map(d => d.invoiceID), [], 'nothing on the customer side');
    assert.deepEqual(docs.bills.map(d => [d.invoiceID, d.type, d.invoiceNumber, d.amountDue]), [['bill-v1', 'ACCPAY', 'Vendor opening balance', 800]]);
  } finally { both.restore(); }

  // Short on the customer side only: the vendor body is still refused, and no bill is read.
  const customerOnly = fakeZoho({ contacts: [contactRow('c1', 'Alpha Trading', 100, 0)] }, {
    '/contacts/c1': contactDetail('c1', [['v1', 800]]),
    '/invoices/v1': vendorAsInvoice,
  });
  try {
    const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED' });
    assert.deepEqual(customerOnly.calls.slice(LISTS.length), ['/contacts/c1', '/invoices/v1']);
    assert.equal(docs.invoices.length, 0);
    assert.equal(docs.bills.length, 0);
  } finally { customerOnly.restore(); }

  // A body with no type is taken only when its number says it is the customer opening balance.
  const untyped = fakeZoho({ contacts: [contactRow('c1', 'Alpha Trading', 400, 0)] }, {
    '/contacts/c1': contactDetail('c1', [['ob-1', 400], ['x-1', 50]]),
    '/invoices/ob-1': { invoice: obInvoice('ob-1', 'c1', 'Alpha Trading', 400, 400, { type: undefined }) },
    '/invoices/x-1': { invoice: { ...obInvoice('x-1', 'c1', 'Alpha Trading', 50), type: undefined, invoice_number: 'INV-77' } },
  });
  try {
    const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED' });
    assert.deepEqual(docs.invoices.map(d => d.invoiceID), ['ob-1']);
  } finally { untyped.restore(); }

  // A customer opening balance answered by /bills/{id} is not taken as a bill.
  const customerAsBill = fakeZoho({ contacts: [contactRow('c1', 'Alpha Trading', 0, 300, 'vendor')] }, {
    '/contacts/c1': contactDetail('c1', [['ob-1', 300]]),
    '/bills/ob-1': { bill: { ...obBill('ob-1', 'c1', 'Alpha Trading', 300), bill_number: 'Customer opening balance' } },
  });
  try {
    const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED' });
    assert.equal(docs.bills.length, 0);
  } finally { customerAsBill.restore(); }
});

test('a failed opening-balance read keeps that contact\'s cached opening balances and says the read was incomplete', async t => {
  t.mock.method(console, 'log', () => {});
  const emitted = [];
  const emit = event => emitted.push(event.message);
  const lists = { contacts: [contactRow('c1', 'Alpha Trading', 100, 0), contactRow('c2', 'Beta Supplies', 200, 0), contactRow('c3', 'Gamma Retail', 0, 300, 'vendor')] };
  // Last good sync's cache: one opening balance per contact, plus a listed invoice (never carried).
  const cached = [
    { ...zoho.mapInvoice(obInvoice('ob-1', 'c1', 'Alpha Trading', 100)), isOpeningBalance: true },
    { ...zoho.mapInvoice(obInvoice('ob-2', 'c2', 'Beta Supplies', 200)), isOpeningBalance: true },
    { ...zoho.mapBill(obBill('ob-3', 'c3', 'Gamma Retail', 300)), isOpeningBalance: true },
    zoho.mapInvoice(invoiceRow('i9', 'c1', 'Alpha Trading', 999)),
  ];
  const cachedOpeningBalances = async () => cached;

  // c1's document read fails (5xx after retries); c2 and c3 read fine.
  const failing = fakeZoho(lists, {
    '/contacts/c1': contactDetail('c1', [['ob-1', 100]]),
    '/invoices/ob-1': new Error('Zoho Books /invoices/ob-1 failed: 503 unavailable'),
    '/contacts/c2': contactDetail('c2', [['ob-2', 200]]),
    '/invoices/ob-2': { invoice: obInvoice('ob-2', 'c2', 'Beta Supplies', 150) },
    '/contacts/c3': contactDetail('c3', [['ob-3', 300]]),
    '/bills/ob-3': { bill: obBill('ob-3', 'c3', 'Gamma Retail', 300) },
  });
  try {
    const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED', emit, cachedOpeningBalances });
    assert.deepEqual(docs.invoices.map(d => [d.invoiceID, d.amountDue]), [['ob-2', 150], ['ob-1', 100]], 'c1 carried from the cache; c2 is the fresh read');
    assert.deepEqual(docs.bills.map(d => d.invoiceID), ['bill-ob-3']);
    assert.deepEqual(docs.openingBalances, { complete: false, stopped: false, contactsNotRead: 1, carriedForward: 1, calls: 6 });
    assert.ok(emitted.some(message => /not all opening balances/i.test(message)));
  } finally { failing.restore(); }

  // A failed contact read: the same.
  const contactFails = fakeZoho(lists, {
    '/contacts/c1': new Error('Zoho Books /contacts/c1 failed: timeout'),
    '/contacts/c2': contactDetail('c2', [['ob-2', 200]]),
    '/invoices/ob-2': { invoice: obInvoice('ob-2', 'c2', 'Beta Supplies', 200) },
    '/contacts/c3': contactDetail('c3', [['ob-3', 300]]),
    '/bills/ob-3': { bill: obBill('ob-3', 'c3', 'Gamma Retail', 300) },
  });
  try {
    const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED', cachedOpeningBalances });
    assert.deepEqual(docs.invoices.map(d => d.invoiceID).sort(), ['ob-1', 'ob-2']);
    assert.equal(docs.openingBalances.contactsNotRead, 1);
  } finally { contactFails.restore(); }

  // The daily limit on c1: c1, and c2 and c3 (never reached), all keep their cached opening balances.
  const limit = fakeZoho(lists, {
    '/contacts/c1': Object.assign(new Error('daily API limit'), { dailyLimit: true }),
  });
  try {
    const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED', cachedOpeningBalances });
    assert.deepEqual(limit.calls.slice(LISTS.length), ['/contacts/c1']);
    assert.deepEqual(docs.invoices.map(d => d.invoiceID).sort(), ['ob-1', 'ob-2']);
    assert.deepEqual(docs.bills.map(d => d.invoiceID), ['bill-ob-3']);
    assert.deepEqual(docs.openingBalances, { complete: false, stopped: true, contactsNotRead: 3, carriedForward: 3, calls: 1 });
  } finally { limit.restore(); }

  // All reads fine: nothing carried, complete, and the loader is not needed.
  let loaderCalls = 0;
  const fine = fakeZoho(lists, {
    '/contacts/c1': contactDetail('c1', [['ob-1', 100]]),
    '/invoices/ob-1': { invoice: obInvoice('ob-1', 'c1', 'Alpha Trading', 100) },
    '/contacts/c2': contactDetail('c2', [['ob-2', 200]]),
    '/invoices/ob-2': { invoice: obInvoice('ob-2', 'c2', 'Beta Supplies', 200) },
    '/contacts/c3': contactDetail('c3', [['ob-3', 300]]),
    '/bills/ob-3': { bill: obBill('ob-3', 'c3', 'Gamma Retail', 300) },
  });
  try {
    const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED', cachedOpeningBalances: async () => { loaderCalls++; return cached; } });
    assert.equal(loaderCalls, 0);
    assert.equal(docs.openingBalances.complete, true);
    assert.equal(docs.openingBalances.carriedForward, 0);
  } finally { fine.restore(); }

  // A vendor id answered 404 by /invoices but read from /bills is not a failure.
  const sides = fakeZoho({ contacts: [contactRow('c1', 'Alpha Trading', 100, 50)] }, {
    '/contacts/c1': contactDetail('c1', [['ob-1', 100], ['ob-4', 50]]),
    '/invoices/ob-1': { invoice: obInvoice('ob-1', 'c1', 'Alpha Trading', 100) },
    '/bills/ob-4': { bill: obBill('ob-4', 'c1', 'Alpha Trading', 50) },
  });
  try {
    const docs = await zoho.fetchDocuments(ORG, { baseCurrency: 'AED', cachedOpeningBalances });
    assert.equal(docs.openingBalances.complete, true);
  } finally { sides.restore(); }
});
