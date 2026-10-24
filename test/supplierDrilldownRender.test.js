// Renders the real check-detail template with synthetic data to prove the supplier drill-down separates transactions
// from the lookback window (Abdur's v4 feedback: "keep results going back 3 months but disaggregate them").
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { groupSupplierTransactions } = require('../src/services/checkPresentation');

const locals = {
  basePath: '/akrio-verify', orgIdentifier: 'synthetic-org', csrfToken: 'token', fmtDisplayDate: value => String(value),
  org: { name: 'Synthetic Ltd', id: 1 },
  issue: { count: 1, potential_value_gbp: 10, period_checked: 'x', synced_at: '2026-10-24' },
  def: { type: 'multi_tax_suppliers', label: 'Multi-Tax Code Suppliers', importance: 'medium' },
  pagination: { page: 1, totalPages: 1, total: 1, items: [] },
  summary: {}, status: 'active', contact: null, checkType: 'multi_tax_suppliers', checkDescriptions: {},
  groupSupplierTransactions,
  // the globals app.js puts on every page
  practiceName: 'Synthetic Practice', cssVersion: 'test', staffName: null, staffRole: null, isStaffManager: false, canAccessSettings: false,
};
const tx = (date, inPeriod, extra = {}) => ({
  date, reference: `REF-${date}`, source: 'bill', invoiceId: `inv-${date}`, taxCode: 'INPUT2', accountCode: '400',
  accountName: 'Office', description: null, amount: 10, inPeriod,
  xero_links: [{ label: 'Open bill', url: `https://example.test/${date}` }], lineKey: `inv-${date}`, ...extra,
});
const item = transactions => ({
  finding_key: 'contact:abc', contactId: 'c1', name: 'Supplier One', taxCodes: ['INPUT2', 'NONE'], dominantTax: 'INPUT2',
  nonDominantValue: 10, transactions, review_state: 'active', xero_links: [], standaloneNote: null,
});
const render = items => ejs.renderFile(path.join(__dirname, '../src/views/checkDetail.ejs'), { ...locals, items });
const order = html => [...html.matchAll(/REF-(\d{4}-\d{2}-\d{2})/g)].map(m => m[1]);

test('flagged lines render in-period first, then a labelled earlier-than-period group, with counts', async () => {
  const html = await render([item([tx('2026-09-01', true), tx('2026-05-01', false), tx('2026-08-01', true)])]);
  assert.deepEqual(order(html), ['2026-09-01', '2026-08-01', '2026-05-01'], 'stable order inside each group, in-period first');
  assert.equal((html.match(/tx-group-row/g) || []).length, 2);
  assert.match(html, /Within the review period \(2\)/);
  assert.match(html, /Earlier than the review period \(lookback only\) \(1\)/);
  assert.match(html, /Show 3 transactions \(2 in the period, 1 earlier\)/);
  assert.doesNotMatch(html, />\s*inPeriod\s*</i, 'the raw flag is not a visible column');
});

test('results saved before the flag existed render as one list, exactly as before', async () => {
  const legacy = [tx('2026-09-01', undefined), tx('2026-05-01', undefined)].map(row => { delete row.inPeriod; return row; });
  const html = await render([item(legacy)]);
  assert.equal((html.match(/tx-group-row/g) || []).length, 0);
  assert.deepEqual(order(html), ['2026-09-01', '2026-05-01']);
  assert.match(html, /Show 2 transactions\s*</);
});

test('a half-flagged list is never guessed at: it renders as one list', async () => {
  const html = await render([item([tx('2026-09-01', true), { ...tx('2026-05-01', false), inPeriod: undefined }])]);
  assert.equal((html.match(/tx-group-row/g) || []).length, 0);
});

test('a supplier whose transactions are all in the period shows one group heading', async () => {
  const html = await render([item([tx('2026-09-01', true), tx('2026-08-01', true)])]);
  assert.equal((html.match(/tx-group-row/g) || []).length, 1);
  assert.match(html, /Show 2 transactions \(2 in the period\)/);
});

// ---- Not-applicable checks on the detail page (Dividends for an LLP, partnership or sole trader) ----
test('the detail page says "Not applicable" for a non-company Dividends check instead of "0 issues found"', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../src/views/checkDetail.ejs'), {
    ...locals, items: [], checkType: 'dividend_status', def: { type: 'dividend_status', label: 'Dividends Status', importance: 'medium' },
    issue: { count: 0, potential_value_gbp: 0, period_checked: 'not_a_company', synced_at: '2026-10-24' }, displayStatus: 'not_applicable',
  });
  assert.match(html, /Not applicable/);
  assert.match(html, /dividends only apply to a limited company/);
  assert.doesNotMatch(html, /issues? found/);
  assert.doesNotMatch(html, /not a company/, 'the raw reserved label is not shown as a reporting period');
});

test('other checks keep the normal header, and an unknown not-applicable label gets a plain reason', async () => {
  const normal = await ejs.renderFile(path.join(__dirname, '../src/views/checkDetail.ejs'), {
    ...locals, items: [], issue: { count: 3, potential_value_gbp: 0, period_checked: 'since_lock_date', synced_at: '2026-10-24' }, displayStatus: 'issues',
  });
  assert.match(normal, /issues found/);
  assert.match(normal, /since lock date/);
  const unknown = await ejs.renderFile(path.join(__dirname, '../src/views/checkDetail.ejs'), {
    ...locals, items: [], issue: { count: 0, potential_value_gbp: 0, period_checked: 'not_applicable_freeagent', synced_at: '2026-10-24' }, displayStatus: 'not_applicable',
  });
  assert.match(unknown, /not applicable to this client/);
});
