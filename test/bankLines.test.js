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

// ---- Reconciliation adjustments (ledger-only entries Xero does not return as bank transactions) ----
const { reconciliationAdjustmentsToLines, saveReconciliationAdjustmentLines } = require('../src/db/bankLines');

const ledgerAccounts = [
  { accountID: 'bank-1', code: '090', name: 'Current Account', type: 'BANK' },
  { accountID: 'bank-2', code: '091', name: 'Savings', type: 'BANK' },
  { accountID: 'round', code: '860', name: 'Rounding', type: 'EXPENSE', systemAccount: 'ROUNDING' },
  { accountID: 'fx', code: '499', name: 'Unrealised Currency Gains', type: 'EXPENSE', systemAccount: 'UNREALISEDCURRENCYGAIN' },
];
const adj = (id, number, date, roundingNet, extra = {}) => ({
  journalID: id, journalNumber: number, journalDate: `${date}T00:00:00`,
  journalLines: [
    { accountID: 'round', accountCode: '860', accountName: 'Rounding', accountType: 'EXPENSE', netAmount: roundingNet, grossAmount: roundingNet, taxAmount: 0, taxType: 'NONE' },
    { accountID: 'bank-1', accountCode: '090', accountName: 'Current Account', accountType: 'BANK', netAmount: -roundingNet, grossAmount: -roundingNet, taxAmount: 0 },
  ], ...extra,
});
const A = { id: 1, lineNo: 2, date: 3, type: 4, status: 5, reconciled: 6, bank: 9, code: 10, name: 11, desc: 13, net: 15, tax: 16, gross: 17, currency: 18 };

test('a ledger-only rounding journal on a bank account becomes a reconciliation adjustment row; a debit to rounding is money out', () => {
  const rows = reconciliationAdjustmentsToLines(7, [adj('j1', 10, '2026-08-17', 2.3)], ledgerAccounts, 'GBP');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row[0], 7);
  assert.equal(row[A.id], 'j1');
  assert.equal(row[A.date], '2026-08-17');
  assert.equal(row[A.type], 'RECON ADJUSTMENT');
  assert.equal(row[A.status], 'AUTHORISED');
  assert.equal(row[A.reconciled], 1);
  assert.equal(row[A.bank], 'Current Account');
  assert.equal(row[A.code], '860');
  assert.equal(row[A.name], 'Rounding');
  assert.equal(row[A.desc], 'Reconciliation adjustment');
  assert.deepEqual([row[A.net], row[A.tax], row[A.gross]], [-2.3, 0, -2.3]);
  assert.equal(row[A.currency], 'GBP');
});

test('a credit to rounding is money in', () => {
  const [row] = reconciliationAdjustmentsToLines(7, [adj('j2', 11, '2025-09-04', -2.64)], ledgerAccounts);
  assert.deepEqual([row[A.net], row[A.gross]], [2.64, 2.64]);
});

test('journals with a source document, no bank line, a non-rounding counter account or two bank accounts are left out', () => {
  const withSource = adj('s1', 1, '2026-01-01', 1, { sourceType: 'CASHPAID', sourceID: 'x' });
  const noBank = { journalID: 'n1', journalNumber: 2, journalDate: '2026-01-01', journalLines: [
    { accountID: 'round', netAmount: 1, grossAmount: 1, taxAmount: 0 }, { accountID: 'fx', netAmount: -1, grossAmount: -1, taxAmount: 0 }] };
  const revaluation = { journalID: 'f1', journalNumber: 3, journalDate: '2026-01-01', journalLines: [
    { accountID: 'fx', netAmount: 5, grossAmount: 5, taxAmount: 0 }, { accountID: 'bank-1', netAmount: -5, grossAmount: -5, taxAmount: 0 }] };
  const twoBanks = { journalID: 't1', journalNumber: 4, journalDate: '2026-01-01', journalLines: [
    { accountID: 'round', netAmount: 1, grossAmount: 1, taxAmount: 0 }, { accountID: 'bank-1', netAmount: -0.5, grossAmount: -0.5, taxAmount: 0 },
    { accountID: 'bank-2', netAmount: -0.5, grossAmount: -0.5, taxAmount: 0 }] };
  assert.deepEqual(reconciliationAdjustmentsToLines(7, [withSource, noBank, revaluation, twoBanks], ledgerAccounts), []);
});

test('an adjustment undone in Xero (same date, opposite amount) is kept but marked reversed; a later re-entry stays live', () => {
  const rows = reconciliationAdjustmentsToLines(7, [
    adj('a', 40340, '2026-01-09', 1.56), adj('b', 40341, '2026-01-09', -1.56), adj('c', 40346, '2026-01-09', 1.56),
    adj('d', 40414, '2026-01-19', -1.56),   // opposite amount on another date is not a reversal
  ], ledgerAccounts);
  const byId = Object.fromEntries(rows.map(r => [r[A.id], r]));
  assert.equal(byId.a[A.status], 'REVERSED');
  assert.equal(byId.b[A.status], 'REVERSED');
  assert.equal(byId.a[A.desc], 'Reconciliation adjustment (reversed)');
  assert.equal(byId.c[A.status], 'AUTHORISED');
  assert.equal(byId.d[A.status], 'AUTHORISED');
  assert.equal(rows.reduce((sum, r) => sum + r[A.net], 0).toFixed(2), '0.00');   // -1.56 +1.56 -1.56 +1.56
});

test('missing accounts, a journal without an id or date, or a non-numeric amount produce no row', () => {
  assert.deepEqual(reconciliationAdjustmentsToLines(7, [adj('j1', 1, '2026-01-01', 1)], []), []);
  assert.deepEqual(reconciliationAdjustmentsToLines(7, [adj(null, 1, '2026-01-01', 1)], ledgerAccounts), []);
  assert.deepEqual(reconciliationAdjustmentsToLines(7, [{ ...adj('j3', 1, '2026-01-01', 1), journalDate: null }], ledgerAccounts), []);
  const bad = adj('j4', 1, '2026-01-01', 1); bad.journalLines[0].netAmount = 'abc';
  assert.deepEqual(reconciliationAdjustmentsToLines(7, [bad], ledgerAccounts), []);
});

test('saving adjustment rows replaces only the supplied adjustment ids, in one transaction, and rolls back on failure', async () => {
  const calls = [];
  const conn = {
    beginTransaction: async () => calls.push('begin'), commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'), release: () => calls.push('release'),
    query: async (sql, params) => { calls.push([sql.replace(/\s+/g, ' ').trim().slice(0, 40), params]); },
  };
  const pool = { getConnection: async () => conn };
  const rows = reconciliationAdjustmentsToLines(7, [adj('j1', 1, '2026-01-01', 1), adj('j2', 2, '2026-01-02', 2)], ledgerAccounts);
  const saved = await saveReconciliationAdjustmentLines(7, rows, { pool, ensure: async () => {} });
  assert.equal(saved, 2);
  assert.equal(calls[0], 'begin');
  const del = calls.find(c => Array.isArray(c) && c[0].startsWith('DELETE'));
  assert.deepEqual(del[1], [7, 'RECON ADJUSTMENT', ['j1', 'j2']]);
  assert.ok(calls.includes('commit'));
  assert.equal(await saveReconciliationAdjustmentLines(7, [], { pool, ensure: async () => {} }), 0);
  await assert.rejects(saveReconciliationAdjustmentLines(8, rows, { pool, ensure: async () => {} }), /organisation/);

  const failing = { ...conn, query: async sql => { if (sql.includes('INSERT')) throw new Error('boom'); } };
  calls.length = 0;
  await assert.rejects(saveReconciliationAdjustmentLines(7, rows, { pool: { getConnection: async () => failing }, ensure: async () => {} }), /boom/);
  assert.ok(calls.includes('rollback') && calls.includes('release'));
});

// Review findings, 18 Nov 2026 (regression tests written before the fixes)
test('opposite half-penny adjustments cancel exactly and are paired as a reversal', () => {
  const rows = reconciliationAdjustmentsToLines(7, [adj('h1', 1, '2026-03-03', 0.125), adj('h2', 2, '2026-03-03', -0.125)], ledgerAccounts);
  assert.equal(rows[0][A.net] + rows[1][A.net], 0);
  assert.deepEqual(rows.map(r => r[A.status]), ['REVERSED', 'REVERSED']);
});

test('a journal with an impossible date is skipped on its own and does not stop the valid ones', () => {
  const rows = reconciliationAdjustmentsToLines(7, [
    adj('bad1', 1, 'not-a-date', 1), { ...adj('bad2', 2, '2026-01-01', 1), journalDate: '2026-02-31T00:00:00' }, adj('ok', 3, '2026-02-10', 1),
  ], ledgerAccounts);
  assert.deepEqual(rows.map(r => r[A.id]), ['ok']);
});

test('the CSV shows a readable type for reconciliation adjustments and leaves other types alone', () => {
  const { csvTypeLabel } = require('../src/routes/bankLinesShared');
  assert.equal(csvTypeLabel('RECON ADJUSTMENT'), 'Reconciliation adjustment');
  assert.equal(csvTypeLabel('SPEND'), 'SPEND');
  assert.equal(csvTypeLabel(null), null);
});
