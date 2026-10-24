// The one Xero call behind Suspense, Director's Loan and Motor Vehicle. No Xero, no database: the API wrapper is injected.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadReviewBalanceSheet, assertUsableBalanceSheet } = require('../src/services/reportChecks');

const usableReport = { reportID: 'BalanceSheet', rows: [{ rowType: 'Header' }, { rowType: 'Section', title: 'Assets', rows: [] }] };

function fakeApi(response, { fail } = {}) {
  const calls = [];
  const callApi = async (tenantId, fn) => {
    const xero = { accountingApi: { getReportBalanceSheet: async (...args) => { calls.push(args); if (fail) throw fail; return response; } } };
    calls.push(['callApi', tenantId]);
    return fn(xero, `xero-${tenantId}`);
  };
  return { callApi, calls };
}

test('a live run asks Xero once, for the period end, with the same arguments the sync always used', async () => {
  const { callApi, calls } = fakeApi({ body: { reports: [usableReport] } });
  const report = await loadReviewBalanceSheet('tenant-1', '2026-04-30', {}, callApi);
  assert.equal(report, usableReport);
  assert.deepEqual(calls, [['callApi', 'tenant-1'], ['xero-tenant-1', '2026-04-30', undefined, undefined, undefined, undefined, true, false]]);
});

test('a cache-only full run and a cache-only run of Suspense / Director\'s Loan / Motor Vehicle also ask once', async () => {
  for (const options of [{ cacheOnly: true }, { cacheOnly: true, checkType: 'suspense_open_balance' },
    { cacheOnly: true, checkType: 'directors_loan_overdrawn' }, { cacheOnly: true, checkType: 'motor_vehicle_expenses' }]) {
    const { callApi, calls } = fakeApi({ body: { reports: [usableReport] } });
    assert.equal(await loadReviewBalanceSheet('t', '2026-04-30', options, callApi), usableReport);
    assert.equal(calls.filter(call => call[0] !== 'callApi').length, 1, JSON.stringify(options));
  }
});

test('a cache-only run of any other single check makes no Xero request from this path', async () => {
  const { callApi, calls } = fakeApi({ body: { reports: [usableReport] } });
  assert.equal(await loadReviewBalanceSheet('t', '2026-04-30', { cacheOnly: true, checkType: 'multi_tax_suppliers' }, callApi), null);
  assert.deepEqual(calls, []);
});

test('an unusable answer throws, so no false "all clear" can replace a real finding', async () => {
  for (const response of [undefined, {}, { body: {} }, { body: { reports: [] } }, { body: { reports: [{}] } },
    { body: { reports: [{ rows: 'nope' }] } }, { body: { reports: [{ rows: [] }] } }]) {
    const { callApi } = fakeApi(response);
    await assert.rejects(loadReviewBalanceSheet('t', '2026-04-30', {}, callApi), /no usable Balance Sheet/, JSON.stringify(response));
  }
});

test('a Xero failure is passed on so the caller can keep the previous results', async () => {
  const { callApi } = fakeApi(null, { fail: new Error('rate limited') });
  await assert.rejects(loadReviewBalanceSheet('t', '2026-04-30', { cacheOnly: true }, callApi), /rate limited/);
});

const row = (label, value) => ({ rowType: 'Row', cells: [{ value: label }, { value }] });
const report = (...sections) => ({ rows: [{ rowType: 'Header' }, ...sections.map(rows => ({ rowType: 'Section', title: 'Assets', rows }))] });

test('a header-only report is rejected: nothing in it says the balances were read', () => {
  assert.throws(() => assertUsableBalanceSheet({ rows: [{ rowType: 'Header' }] }), /no usable Balance Sheet/);
});

test('a balance row whose value cannot be read as a number is rejected, so it cannot become a false zero', () => {
  for (const bad of ['unreadable', 'not available', 'n/a', '12abc', '1.2.3']) {
    assert.throws(() => assertUsableBalanceSheet(report([row('Suspense', bad)])), /unreadable/i, bad);
    assert.throws(() => assertUsableBalanceSheet(report([row('Directors Loan', '1,000.00'), row('Suspense', bad)])), /unreadable/i, `${bad} after a good row`);
  }
  const nested = { rows: [{ rowType: 'Section', title: 'Liabilities', rows: [{ rowType: 'Section', title: 'Current', rows: [row('Suspense', 'oops')] }] }] };
  assert.throws(() => assertUsableBalanceSheet(nested), /unreadable/i, 'nested sections are checked too');
});

test('readable numbers in every format Xero uses are accepted, including real zeros and blanks', () => {
  for (const good of ['0', '0.00', '-1,234.50', '1234.5', '(12.00)', '£1,000', 250, 0, -5.5, '', null, undefined]) {
    assert.doesNotThrow(() => assertUsableBalanceSheet(report([row('Suspense', good)])), String(good));
  }
});

test('a report with sections but no account rows, or with only unrelated accounts, is a genuine "nothing to report"', () => {
  assert.doesNotThrow(() => assertUsableBalanceSheet(report([])));
  assert.doesNotThrow(() => assertUsableBalanceSheet(report([row('Bank Current Account', '5,000.00')])));
  assert.equal(assertUsableBalanceSheet(usableReport), usableReport);
});

test('a summary row, or a row with no label, is not a balance and does not matter', () => {
  const ok = { rows: [{ rowType: 'Section', rows: [
    { rowType: 'SummaryRow', cells: [{ value: 'Total' }, { value: 'x' }] },
    { rowType: 'Row', cells: [{ value: '' }] },
    { rowType: 'Row', cells: [] },
    { rowType: 'Row' },
  ] }] };
  assert.doesNotThrow(() => assertUsableBalanceSheet(ok));
});

test('REGRESSION: a labelled account row with no value cell is rejected (it would otherwise read as a false zero)', () => {
  for (const cells of [[{ value: 'Suspense' }], [{ value: "Directors' Loan Account" }]]) {
    const incomplete = { rows: [{ rowType: 'Section', title: 'Assets', rows: [{ rowType: 'Row', cells }] }] };
    assert.throws(() => assertUsableBalanceSheet(incomplete), /unreadable|incomplete/i);
  }
});

test('a section whose child list is not a list is rejected; an empty section is fine', () => {
  assert.throws(() => assertUsableBalanceSheet({ rows: [{ rowType: 'Section', rows: 'oops' }] }), /unreadable|incomplete|usable/i);
  assert.throws(() => assertUsableBalanceSheet({ rows: [{ rowType: 'Section', rows: { not: 'a list' } }] }), /unreadable|incomplete|usable/i);
  assert.doesNotThrow(() => assertUsableBalanceSheet({ rows: [{ rowType: 'Section', rows: [] }] }));
  assert.doesNotThrow(() => assertUsableBalanceSheet({ rows: [{ rowType: 'Section' }] }));
});

test('a rejected report leaves the previous Suspense and Director\'s Loan results in place (through the loader)', async () => {
  const bad = { body: { reports: [report([row('Suspense', 'not available'), row("Directors' Loan", 'not available')])] } };
  const { callApi } = fakeApi(bad);
  await assert.rejects(loadReviewBalanceSheet('t', '2026-04-30', { cacheOnly: true }, callApi), /unreadable/i);
});
