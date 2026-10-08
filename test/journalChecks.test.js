const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHECK_TYPES, VAT_LIMITS, detectUnusualJournals, suspenseOpenBalances, taxReviewByCode,
  classifyVatScheme, rollingVatTurnover, evaluateVatScheme,
} = require('../src/services/journalChecks');

const accounts = [
  { code: '200', name: 'Sales', type: 'REVENUE', _class: 'REVENUE' },
  { code: '477', name: 'Wages and Salaries', type: 'DIRECTCOSTS', _class: 'EXPENSE' },
  { code: '090', name: 'Business Bank Account', type: 'BANK', _class: 'ASSET' },
  { code: '820', name: 'VAT', type: 'CURRLIAB', _class: 'LIABILITY', systemAccount: 'GST' },
  { code: '710', name: 'Office Equipment', type: 'FIXED', _class: 'ASSET' },
  { code: '860', name: 'Loss on disposal', type: 'EXPENSE', _class: 'EXPENSE' },
  { code: '999', name: 'Suspense', type: 'CURRENT', _class: 'ASSET' },
];
const journal = (id, lines, extra = {}) => ({
  manualJournalID: id, status: 'POSTED', date: '2026-06-30', narration: 'test',
  journalLines: lines.map(([accountCode, lineAmount]) => ({ accountCode, lineAmount })), ...extra,
});

test('flags revenue debited against an expense credit', () => {
  const out = detectUnusualJournals({ accounts, journals: [journal('J1', [['200', 500], ['477', -500]])] });
  assert.equal(out[CHECK_TYPES.revenueVsExpense].length, 1);
  assert.equal(out[CHECK_TYPES.revenueVsExpense][0].amount, 500);
  assert.equal(out[CHECK_TYPES.revenueVsExpense][0].counterAccountCode, '477');
});

test('does not flag the normal direction (credit sales, debit expense)', () => {
  const out = detectUnusualJournals({ accounts, journals: [journal('J2', [['200', -500], ['477', 500]])] });
  assert.equal(out[CHECK_TYPES.revenueVsExpense].length, 0);
});

test('flags any manual journal line on the VAT control account', () => {
  const out = detectUnusualJournals({ accounts, journals: [journal('J3', [['820', 120], ['477', -120]])] });
  assert.equal(out[CHECK_TYPES.vatControl].length, 1);
});

test('flags manual journal lines posted to a bank account', () => {
  const out = detectUnusualJournals({ accounts, journals: [journal('J4', [['090', 300], ['200', -300]])] });
  assert.equal(out[CHECK_TYPES.bankJournal].length, 1);
});

test('flags fixed asset cost credited to an expense with no disposal entry, but not with one', () => {
  const flagged = detectUnusualJournals({ accounts, journals: [journal('J5', [['710', -900], ['477', 900]])] });
  assert.equal(flagged[CHECK_TYPES.fixedAssetToExpense].length, 1);
  const withDisposal = detectUnusualJournals({ accounts, journals: [journal('J6', [['710', -900], ['860', 900]])] });
  assert.equal(withDisposal[CHECK_TYPES.fixedAssetToExpense].length, 0);
});

test('ignores journals that are not POSTED and journals with unknown accounts', () => {
  const out = detectUnusualJournals({
    accounts,
    journals: [journal('J7', [['200', 500], ['477', -500]], { status: 'DRAFT' }), journal('J8', [['111', 5], ['222', -5]])],
  });
  assert.ok(Object.values(out).every(items => items.length === 0));
});

test('suspenseOpenBalances finds suspense and clearing accounts with a balance at period end', () => {
  const report = { rows: [{ rowType: 'Section', rows: [
    { rowType: 'Row', cells: [{ value: 'Suspense (999)' }, { value: '250.00' }, { value: '' }] },
    { rowType: 'Row', cells: [{ value: 'Payroll Clearing (998)' }, { value: '' }, { value: '40.50' }] },
    { rowType: 'Row', cells: [{ value: 'Sales (200)' }, { value: '' }, { value: '9000' }] },
    { rowType: 'Row', cells: [{ value: 'Suspense Old (997)' }, { value: '0.00' }, { value: '0.00' }] },
  ] }] };
  const out = suspenseOpenBalances(report, { asOf: '2026-10-08' });
  assert.deepEqual(out.map(i => [i.accountCode, i.amount]), [['999', 250], ['998', 40.5]]);
});

test('taxReviewByCode groups lines by tax code and applies the minimum value', () => {
  const docs = [
    { lineAmountTypes: 'Exclusive', lineItems: [{ lineAmount: 100, taxAmount: 20, taxType: 'OUTPUT2' }, { lineAmount: 50, taxAmount: 10, taxType: 'OUTPUT2' }, { lineAmount: 30, taxAmount: 0, taxType: 'NONE' }] },
  ];
  const all = taxReviewByCode({ documents: docs, taxRates: [{ taxType: 'OUTPUT2', name: '20% (VAT on Income)' }] });
  assert.deepEqual(all.map(i => [i.accountCode, i.amount, i.lineCount]), [['OUTPUT2', 150, 2], ['NONE', 30, 1]]);
  assert.equal(taxReviewByCode({ documents: docs, minValue: 100 }).length, 1);
});

test('classifyVatScheme maps Xero basis and period to a scheme', () => {
  assert.equal(classifyVatScheme('NONE'), 'unregistered');
  assert.equal(classifyVatScheme(undefined), 'unregistered');
  assert.equal(classifyVatScheme('FLATRATECASH'), 'flat_rate');
  assert.equal(classifyVatScheme('PAYMENTS'), 'cash');
  assert.equal(classifyVatScheme('ACCRUAL', 'ANNUALLY'), 'annual');
  assert.equal(classifyVatScheme('ACCRUAL', 'QUARTERLY1'), 'standard');
});

test('rollingVatTurnover counts zero-rated as taxable and excludes exempt/outside scope, credit notes subtract', () => {
  const taxRates = [
    { taxType: 'OUTPUT2', effectiveRate: 20, canApplyToRevenue: true },
    { taxType: 'ZERORATEDOUTPUT', effectiveRate: 0, canApplyToRevenue: true },
    { taxType: 'EXEMPTOUTPUT', effectiveRate: 0, canApplyToRevenue: true },
    { taxType: 'NONE', effectiveRate: 0, canApplyToRevenue: true },
  ];
  const documents = [
    { date: '2026-05-01', lineAmountTypes: 'Exclusive', lineItems: [
      { accountCode: '200', lineAmount: 1000, taxAmount: 200, taxType: 'OUTPUT2' },
      { accountCode: '200', lineAmount: 500, taxAmount: 0, taxType: 'ZERORATEDOUTPUT' },
      { accountCode: '200', lineAmount: 300, taxAmount: 0, taxType: 'EXEMPTOUTPUT' },
      { accountCode: '477', lineAmount: 999, taxAmount: 0, taxType: 'OUTPUT2' },
    ] },
    { date: '2026-05-02', __sign: -1, lineAmountTypes: 'Exclusive', lineItems: [{ accountCode: '200', lineAmount: 100, taxAmount: 20, taxType: 'OUTPUT2' }] },
    { date: '2024-01-01', lineAmountTypes: 'Exclusive', lineItems: [{ accountCode: '200', lineAmount: 7777, taxAmount: 0, taxType: 'OUTPUT2' }] },
  ];
  const out = rollingVatTurnover({ documents, taxRates, revenueCodes: new Set(['200']), from: '2025-10-09', to: '2026-10-08' });
  assert.equal(out.taxableNet, 1400);
  assert.equal(out.grossIncome, 1000 + 200 + 500 + 300 - 120);
});

test('evaluateVatScheme bands follow the agreed limits', () => {
  const e = (scheme, taxableNet, grossIncome = 0) => evaluateVatScheme({ scheme, taxableNet, grossIncome });
  assert.equal(e('unregistered', 80000).level, 'ok');
  assert.equal(e('unregistered', 81000).level, 'amber');
  assert.equal(e('unregistered', 90001).level, 'red');
  assert.equal(e('standard', 87999).level, 'info');
  assert.equal(e('standard', 88000).level, 'ok');
  assert.equal(e('flat_rate', 0, 207000).level, 'amber');
  assert.equal(e('flat_rate', 0, 230001).level, 'red');
  assert.equal(e('cash', 1440000).level, 'amber');
  assert.equal(e('annual', 1600001).level, 'red');
  assert.equal(VAT_LIMITS.registration, 90000);
});

test('review checks are non-scored: adding them never changes the health score', () => {
  const { calculateHealthScore, NON_SCORED_CHECKS, ALL_CHECK_DEFINITIONS } = require('../src/services/checkRules');
  const base = [{ check_type: 'purchase_tax_missing', importance: 'medium', count: 10, potential_value_gbp: 500, period_checked: 'since_lock_date' }];
  const extras = Object.values(CHECK_TYPES).map(type => ({ check_type: type, importance: 'medium', count: 50, potential_value_gbp: 99999, period_checked: 'since_lock_date' }));
  assert.equal(calculateHealthScore([...base, ...extras]), calculateHealthScore(base));
  for (const type of Object.values(CHECK_TYPES)) {
    assert.ok(NON_SCORED_CHECKS.includes(type), `${type} must be non-scored`);
    assert.ok(ALL_CHECK_DEFINITIONS.some(d => d.type === type), `${type} must be listed`);
  }
});
