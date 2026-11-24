// FreeAgent adapter: every page is read, options reach FreeAgent, ids do not collide.
// Until 24 Nov 2026 page/per_page were passed outside `params`, so FreeAgent answered with its
// default 25 rows and only the first page was read. A fake FreeAgent stands in; made-up data.
const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
let data = {};
const clientPath = require.resolve('../src/services/freeagentClient');
require.cache[clientPath] = {
  id: clientPath, filename: clientPath, loaded: true,
  exports: {
    // Behaves like FreeAgent: per_page defaults to 25, max 100; page defaults to 1.
    apiCall: async (companyId, path, { params } = {}) => {
      calls.push({ path, params: { ...(params || {}) } });
      const perPage = Math.min(Number(params?.per_page) || 25, 100);
      const page = Number(params?.page) || 1;
      const key = path.replace('/v2/', '');
      const all = data[key] || [];
      return { [key]: all.slice((page - 1) * perPage, page * perPage) };
    },
  },
};
const adapter = require('../src/services/freeagentAdapter');

const many = (kind, n, extra = () => ({})) => Array.from({ length: n }, (_, i) => ({
  url: `https://api.freeagent.com/v2/${kind}/${i + 1}`, reference: `${kind}-${i + 1}`, status: 'Open',
  dated_on: '2026-10-01', due_on: '2026-10-31', total_value: '120.0', net_value: '100.0', due_value: '120.0',
  contact: 'https://api.freeagent.com/v2/contacts/1', ...extra(i),
}));

test.beforeEach(() => { calls.length = 0; });

test('reads every page, not just the first 25', async () => {
  data = { contacts: [{ url: 'https://api.freeagent.com/v2/contacts/1', organisation_name: 'Made Up Ltd', status: 'Active' }], invoices: many('invoices', 230) };
  const invoices = await adapter.fetchAllInvoices('co');
  assert.equal(invoices.length, 230);
  const invoiceCalls = calls.filter(c => c.path === '/v2/invoices');
  assert.deepEqual(invoiceCalls.map(c => c.params.page), [1, 2, 3]);
  for (const c of invoiceCalls) {
    assert.equal(c.params.per_page, 100);
    assert.equal(c.params.view, 'all');
    assert.equal(c.params.nested_invoice_items, true, 'line items are asked for');
  }
  assert.equal(invoices[0].contact.name, 'Made Up Ltd');
});

test('an exact multiple of 100 reads one empty page and stops', async () => {
  data = { contacts: [], bills: many('bills', 200) };
  const bills = await adapter.fetchAllBills('co', undefined, new Map());
  assert.equal(bills.length, 200);
  assert.deepEqual(calls.filter(c => c.path === '/v2/bills').map(c => c.params.page), [1, 2, 3]);
});

test('invoice 5 and bill 5 no longer share an id', async () => {
  data = { contacts: [], invoices: many('invoices', 5), bills: many('bills', 5) };
  const invoices = await adapter.fetchAllInvoices('co', undefined, new Map());
  const bills = await adapter.fetchAllBills('co', undefined, new Map());
  const ids = new Set([...invoices, ...bills].map(d => d.invoiceID));
  assert.equal(ids.size, 10);
  assert.equal(bills[4].invoiceID, 'bill-5');
  assert.equal(invoices[4].invoiceID, '5');
  assert.equal(bills[0].type, 'ACCPAY');
});

test('updated_since is sent as ISO 8601; nothing is sent when there is no date', async () => {
  data = { contacts: [], credit_notes: [] };
  await adapter.fetchAllCreditNotes('co', new Date('2026-11-01T02:00:00Z'), new Map());
  assert.equal(calls.at(-1).params.updated_since, '2026-11-01T02:00:00.000Z');
  await adapter.fetchAllCreditNotes('co', undefined, new Map());
  assert.equal(calls.at(-1).params.updated_since, undefined);
  assert.equal(adapter.isoSince('not a date'), undefined);
});

test('contacts include hidden ones; the contact map is not re-read when one is passed in', async () => {
  data = { contacts: [
    { url: 'https://api.freeagent.com/v2/contacts/1', first_name: 'Ann', last_name: 'Example', status: 'Active' },
    { url: 'https://api.freeagent.com/v2/contacts/2', organisation_name: 'Old Supplier', status: 'Hidden' },
  ], invoices: [] };
  const contacts = await adapter.fetchAllContacts('co');
  assert.deepEqual(contacts.map(c => [c.name, c.contactStatus]), [['Ann Example', 'ACTIVE'], ['Old Supplier', 'ARCHIVED']]);
  assert.equal(calls[0].params.view, 'all');
  calls.length = 0;
  await adapter.fetchAllInvoices('co', undefined, new Map());
  assert.equal(calls.filter(c => c.path === '/v2/contacts').length, 0);
});

test('credit notes are positive amounts whichever sign FreeAgent uses', async () => {
  data = { contacts: [], credit_notes: [
    { url: '.../credit_notes/1', status: 'Open', total_value: '-120.0', net_value: '-100.0', due_value: '-120.0' },
    { url: '.../credit_notes/2', status: 'Open', total_value: '200.0', net_value: '200.0', due_value: '150.0' },
  ] };
  const notes = await adapter.fetchAllCreditNotes('co', undefined, new Map());
  assert.deepEqual(notes.map(n => [n.total, n.subTotal, n.remainingCredit]), [[120, 100, 120], [200, 200, 150]]);
  assert.ok(notes.every(n => n.type === 'ACCRECCREDIT'));
});

test('a runaway list stops with an error instead of returning a partial list', async () => {
  const realApi = require.cache[clientPath].exports.apiCall;
  // Not reachable with real data (2,000 pages = 200,000 rows); proves the guard throws.
  require.cache[clientPath].exports.apiCall = async () => ({ invoices: Array(100).fill({ url: 'x/1', status: 'Open' }) });
  delete require.cache[require.resolve('../src/services/freeagentAdapter')];
  const fresh = require('../src/services/freeagentAdapter');
  await assert.rejects(fresh.fetchAllInvoices('co', undefined, new Map()), /more than 2000 pages/);
  require.cache[clientPath].exports.apiCall = realApi;
});
