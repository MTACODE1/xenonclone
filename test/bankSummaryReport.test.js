// Xero's Bank Summary report has an extra "FX Gain" column for organisations with foreign-currency accounts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bankSummaryColumns, bankSummaryRowBalances } = require('../src/services/bankSummaryReport');

const cells = values => ({ cells: values.map(value => ({ value })) });
const report = (headings, rows) => ({ rows: [{ rowType: 'Header', ...cells(headings) }, { rowType: 'Section', rows }] });

test('single-currency layout: closing balance is the fifth column', () => {
  const r = report(['Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'Closing Balance'], []);
  const columns = bankSummaryColumns(r);
  assert.deepEqual(columns, { opening: 1, closing: 4 });
  assert.deepEqual(bankSummaryRowBalances(cells(['Current', '100.00', '50.00', '30.00', '120.00']), columns), { opening: 100, closing: 120 });
});

test('multi-currency layout: the FX Gain column is not mistaken for the closing balance', () => {
  const r = report(['Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'FX Gain', 'Closing Balance'], []);
  const columns = bankSummaryColumns(r);
  assert.deepEqual(columns, { opening: 1, closing: 5 });
  assert.deepEqual(bankSummaryRowBalances(cells(['Sterling', '1,000.00', '0.00', '0.00', '0.00', '86,490.46']), columns), { opening: 1000, closing: 86490.46 });
  assert.deepEqual(bankSummaryRowBalances(cells(['Euro', '900.00', '10.00', '5.00', '-53.09', '851.91']), columns), { opening: 900, closing: 851.91 });
});

test('no heading row: opening is the first figure and closing the last, in either layout', () => {
  const columns = bankSummaryColumns({ rows: [] });
  assert.equal(bankSummaryRowBalances(cells(['A', '1.00', '2.00', '3.00', '4.00']), columns).closing, 4);
  assert.equal(bankSummaryRowBalances(cells(['A', '1.00', '2.00', '3.00', '0.50', '6.00']), columns).closing, 6);
  assert.equal(bankSummaryRowBalances(cells(['A']), columns).closing, null);
  assert.equal(bankSummaryRowBalances(cells(['A', '', '', '', '']), bankSummaryColumns(report(['x', 'Opening Balance', 'a', 'b', 'Closing Balance'], []))).closing, null);
});
