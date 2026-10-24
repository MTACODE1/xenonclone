const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { formatTurnoverGbp, groupSupplierTransactions } = require('../src/services/checkPresentation');

test('turnover is shown with pence so it can be compared with Xero to the penny', () => {
  assert.equal(formatTurnoverGbp(1234.05), '£1,234.05');
  assert.equal(formatTurnoverGbp(1234.49), '£1,234.49');
  assert.equal(formatTurnoverGbp(181990.36999999988), '£181,990.37', 'a float tail does not show');
  assert.equal(formatTurnoverGbp(0), '£0.00');
  assert.equal(formatTurnoverGbp(null), '£0.00');
  assert.equal(formatTurnoverGbp(undefined), '£0.00');
  assert.equal(formatTurnoverGbp('abc'), '£0.00');
  assert.equal(formatTurnoverGbp(-50), '-£50.00');
  assert.equal(formatTurnoverGbp(-0.001), '£0.00', 'a tiny negative does not read as -£0.00');
  assert.equal(formatTurnoverGbp(1000000), '£1,000,000.00');
});

test('the client page uses the formatter for the turnover tile and keeps the per-month figure rounded', () => {
  const view = fs.readFileSync(path.join(__dirname, '../src/views/client.ejs'), 'utf8');
  assert.match(view, /item\.isCurrency \? formatTurnoverGbp\(item\.raw\)/);
  assert.match(view, /perMthDisplay = item\.isCurrency \? '£' \+ Math\.round\(item\.raw \/ mth\)/);
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/client.js'), 'utf8');
  assert.match(route, /formatTurnoverGbp,\n\s*\};/, 'the client page is given the formatter');
});

const row = (n, inPeriod) => ({ n, ...(inPeriod === undefined ? {} : { inPeriod }) });

test('fully flagged transactions split into the review period first and earlier lines second, order kept', () => {
  const input = [row(1, true), row(2, false), row(3, true), row(4, false), row(5, true)];
  const result = groupSupplierTransactions(input);
  assert.equal(result.grouped, true);
  assert.deepEqual(result.groups.map(g => [g.key, g.rows.map(r => r.n)]), [['period', [1, 3, 5]], ['earlier', [2, 4]]]);
  assert.match(result.groups[0].label, /review period/);
  assert.match(result.groups[1].label, /Earlier than the review period/);
  assert.deepEqual(input.map(r => r.n), [1, 2, 3, 4, 5], 'the input is not reordered or changed');
});

test('only one group is returned when every line is in the period, or every line is earlier', () => {
  assert.deepEqual(groupSupplierTransactions([row(1, true), row(2, true)]).groups.map(g => g.key), ['period']);
  assert.deepEqual(groupSupplierTransactions([row(1, false)]).groups.map(g => g.key), ['earlier']);
});

test('legacy, mixed, empty and invalid input is one plain list, never guessed at', () => {
  for (const input of [[row(1), row(2)], [row(1, true), row(2)], [row(1, 'yes'), row(2, true)], [row(1, null)]]) {
    const result = groupSupplierTransactions(input);
    assert.equal(result.grouped, false);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].label, null);
    assert.deepEqual(result.groups[0].rows, input);
  }
  assert.deepEqual(groupSupplierTransactions([]), { grouped: false, groups: [{ key: 'all', label: null, rows: [] }] });
  assert.deepEqual(groupSupplierTransactions(undefined), { grouped: false, groups: [{ key: 'all', label: null, rows: [] }] });
});
