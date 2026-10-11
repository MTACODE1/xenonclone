const test = require('node:test');
const assert = require('node:assert/strict');
const { bankTransactionsToLines } = require('../src/db/bankLines');
const { csvCell } = require('../src/routes/bankLinesShared');

const accounts = { 200: { name: 'Sales', type: 'REVENUE' }, 429: { name: 'General Expenses', type: 'OVERHEADS' } };
const txn = overrides => ({
  bankTransactionID: 'b1', type: 'SPEND', status: 'AUTHORISED', isReconciled: true, date: '2026-03-02T00:00:00',
  contact: { name: 'Stripe' }, bankAccount: { name: 'Monzo' }, currencyCode: 'GBP', lineAmountTypes: 'Exclusive',
  lineItems: [{ accountCode: '429', description: 'Fees', taxType: 'INPUT2', lineAmount: 100, taxAmount: 20 }], ...overrides,
});
// column order: org, id, line_no, date, type, status, reconciled, contact, ref, bank, code, name, type, desc, tax, net, tax, gross
const COL = { code: 10, name: 11, net: 15, tax: 16, gross: 17, lineNo: 2, date: 3 };

test('spend line keeps its account code and name, and money out is negative', () => {
  const [row] = bankTransactionsToLines(5, [txn()], accounts);
  assert.equal(row[COL.code], '429');
  assert.equal(row[COL.name], 'General Expenses');
  assert.deepEqual([row[COL.net], row[COL.tax], row[COL.gross]], [-100, -20, -120]);
  assert.equal(row[COL.date], '2026-03-02');
});

test('tax-inclusive receive splits tax out of the line amount', () => {
  const [row] = bankTransactionsToLines(5, [txn({
    type: 'RECEIVE', lineAmountTypes: 'Inclusive',
    lineItems: [{ accountCode: '200', lineAmount: 930, taxAmount: 155 }],
  })], accounts);
  assert.deepEqual([row[COL.net], row[COL.tax], row[COL.gross]], [775, 155, 930]);
});

test('a split transaction produces one row per line with increasing line numbers', () => {
  const rows = bankTransactionsToLines(5, [txn({
    lineItems: [{ accountCode: '200', lineAmount: 10 }, { accountCode: '429', lineAmount: 5 }],
  })], accounts);
  assert.deepEqual(rows.map(r => [r[COL.lineNo], r[COL.code]]), [[0, '200'], [1, '429']]);
});

test('a transfer keeps its signed amount and has no account', () => {
  const [row] = bankTransactionsToLines(5, [txn({
    type: 'SPEND-TRANSFER', lineAmountTypes: 'NoTax', lineItems: [{ lineAmount: -570.11, taxAmount: 0 }],
  })], accounts);
  assert.equal(row[COL.code], null);
  assert.equal(row[COL.gross], -570.11);
});

test('a transaction with no lines is still kept as one row', () => {
  assert.equal(bankTransactionsToLines(5, [txn({ lineItems: [] })], accounts).length, 1);
});

test('csv cells cannot be run as spreadsheet formulas', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('-12.50'), '-12.50');
  assert.equal(csvCell('Smith, J'), '"Smith, J"');
});
