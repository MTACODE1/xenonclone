// Xero's Reports/BalanceSheet JSON is flat: an empty "Assets" heading section, then sibling sections such as "Bank",
// "Current Assets" and "Fixed Assets", then an empty "Liabilities" heading, and so on. A row under "Bank" is an asset
// even though the word "asset" is not in its own section title. Synthetic labels and amounts only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { balanceSheetRows, directorsLoanAlerts, suspenseOpenBalances, motorVehicleExpenses } = require('../src/services/journalChecks');

const row = (label, value) => ({ rowType: 'Row', cells: [{ value: label }, { value }] });
const summary = (label, value) => ({ rowType: 'SummaryRow', cells: [{ value: label }, { value }] });
const flatReport = (bankLoan, liabilityLoan = '-1,000.00') => ({
  rows: [
    { rowType: 'Header', cells: [{ value: '' }, { value: '31 Oct 2026' }] },
    { rowType: 'Section', title: 'Assets', rows: [] },
    { rowType: 'Section', title: 'Bank', rows: [row('Business Current Account', '5,000.00'), row('Directors Loan (B)', bankLoan), summary('Total Bank', '0.00')] },
    { rowType: 'Section', title: 'Current Assets', rows: [row('Trade Debtors', '2,000.00'), row('Suspense', '75.00')] },
    { rowType: 'Section', title: 'Fixed Assets', rows: [row('Motor Vehicles', '12,000.00')] },
    { rowType: 'Section', title: '', rows: [summary('Total Assets', '19,075.00')] },
    { rowType: 'Section', title: 'Liabilities', rows: [] },
    { rowType: 'Section', title: 'Current Liabilities', rows: [row('Directors Loan (A)', liabilityLoan), row('VAT', '1,200.00')] },
    { rowType: 'Section', title: 'Non-current Liabilities', rows: [row('Bank Loan', '8,000.00')] },
    { rowType: 'Section', title: '', rows: [summary('Total Liabilities', '0.00')] },
    { rowType: 'Section', title: '', rows: [summary('Net Assets', '0.00')] },
    { rowType: 'Section', title: 'Equity', rows: [row('Owner Drawings', '-3,000.00'), row('Retained Earnings', '9,000.00')] },
  ],
});

test('flat layout: sections after an empty Assets heading are assets, after Liabilities are not', () => {
  const rows = balanceSheetRows(flatReport('-2,500.00'));
  const byLabel = Object.fromEntries(rows.map(r => [r.label, r]));
  assert.equal(byLabel['Business Current Account'].isAsset, true);
  assert.equal(byLabel['Directors Loan (B)'].isAsset, true, 'a Bank-section row is an asset');
  assert.equal(byLabel['Trade Debtors'].isAsset, true);
  assert.equal(byLabel['Motor Vehicles'].isAsset, true);
  assert.equal(byLabel['Directors Loan (A)'].isAsset, false);
  assert.equal(byLabel['Bank Loan'].isAsset, false, 'a liability named "Bank Loan" stays a liability');
  assert.equal(byLabel['Owner Drawings'].isAsset, false);
  assert.match(byLabel['Directors Loan (B)'].section, /Assets > Bank/);
  assert.deepEqual(rows.map(r => r.label).slice(0, 3), ['Business Current Account', 'Directors Loan (B)', 'Trade Debtors'],
    'row order kept; summary rows are not account rows');
});

test('a director loan set up as a bank account with a credit balance is not overdrawn', () => {
  const alerts = directorsLoanAlerts(flatReport('-2,500.00', '500.00'));
  assert.deepEqual(alerts.map(a => [a.accountCode, a.amount]), [], 'credit on the bank-type loan, credit on the liability loan');
});

test('a director loan set up as a bank account with a debit balance is overdrawn', () => {
  const alerts = directorsLoanAlerts(flatReport('2,500.00', '500.00'));
  assert.deepEqual(alerts.map(a => [a.accountCode, a.amount]), [['Directors Loan (B)', 2500]]);
});

test('a liability-section loan reads as before: a negative balance is overdrawn', () => {
  const alerts = directorsLoanAlerts(flatReport('0.00', '-1,000.00'));
  assert.deepEqual(alerts.map(a => [a.accountCode, a.amount]), [['Directors Loan (A)', 1000]]);
});

test('equity Drawings stay excluded in the flat layout', () => {
  assert.ok(!directorsLoanAlerts(flatReport('0.00', '0.00')).some(a => /Drawings/.test(a.accountCode)));
});

test('the heading carries into the next sibling only until another major heading', () => {
  const report = { rows: [
    { rowType: 'Section', title: 'Assets', rows: [] },
    { rowType: 'Section', title: 'Bank', rows: [row('A', '1')] },
    { rowType: 'Section', title: 'Liabilities', rows: [] },
    { rowType: 'Section', title: 'Bank', rows: [row('B', '1')] },
    { rowType: 'Section', title: 'Equity', rows: [row('C', '1')] },
  ] };
  assert.deepEqual(balanceSheetRows(report).map(r => [r.label, r.isAsset]), [['A', true], ['B', false], ['C', false]]);
});

test('a populated major section resets the flat context, and nesting does not leak it', () => {
  const report = { rows: [
    { rowType: 'Section', title: 'Assets', rows: [] },
    { rowType: 'Section', title: 'Liabilities', rows: [
      { rowType: 'Section', title: 'Bank', rows: [row('Overdraft', '1')] },
    ] },
    { rowType: 'Section', title: 'Bank', rows: [row('After', '1')] },
  ] };
  assert.deepEqual(balanceSheetRows(report).map(r => [r.label, r.isAsset]), [['Overdraft', false], ['After', false]]);
});

test('without any heading a lone Bank section is not guessed to be an asset', () => {
  const report = { rows: [{ rowType: 'Section', title: 'Bank', rows: [row('Directors Loan', '-100')] }] };
  assert.equal(balanceSheetRows(report)[0].isAsset, false);
});

test('suspense balances and the motor vehicle asset test still work on the flat layout', () => {
  const report = flatReport('0.00');
  assert.deepEqual(suspenseOpenBalances(report).map(s => [s.accountCode, s.amount]), [['Suspense', 75]]);
  const accounts = [{ code: '449', name: 'Motor Vehicle Expenses', type: 'EXPENSE' }];
  const documents = [{ date: '2026-06-01', lineItems: [{ accountCode: '449', lineAmount: 100, taxAmount: 0 }] }];
  const withAsset = motorVehicleExpenses({ accounts, documents, journals: [], from: '2026-01-01', to: '2026-12-31', balanceSheet: report });
  const withoutAsset = motorVehicleExpenses({ accounts, documents, journals: [], from: '2026-01-01', to: '2026-12-31', balanceSheet: { rows: [] } });
  assert.equal(withoutAsset.length, 1, 'no vehicle on the balance sheet: the expense is flagged');
  assert.equal(withAsset.length, 0, 'a vehicle under Fixed Assets (flat layout) suppresses the finding');
});

test('direct rows after a heading and an empty Equity heading are classified', () => {
  const report = { rows: [
    { rowType: 'Section', title: 'Assets', rows: [] },
    row('Directors Current Account', '-40.00'),
    { rowType: 'Section', title: 'Equity', rows: [] },
    { rowType: 'Section', title: 'Reserves', rows: [row('Owner Drawings', '-3,000.00')] },
  ] };
  const rows = balanceSheetRows(report);
  assert.deepEqual(rows.map(r => [r.label, r.isAsset, r.section]), [
    ['Directors Current Account', true, 'Assets'], ['Owner Drawings', false, 'Equity > Reserves'],
  ]);
  assert.deepEqual(directorsLoanAlerts(report), [], 'a credit on an asset-side loan is not overdrawn; equity drawings excluded');
});
