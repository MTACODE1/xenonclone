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

const bsReport = {
  rows: [
    { rowType: 'Section', title: 'Assets', rows: [
      { rowType: 'Section', title: 'Current Assets', rows: [
        { rowType: 'Row', cells: [{ value: 'Suspense' }, { value: '250.00' }, { value: '0.00' }] },
        { rowType: 'Row', cells: [{ value: 'Director Loan Account' }, { value: '4,000.00' }, { value: '0.00' }] },
        { rowType: 'Row', cells: [{ value: 'Trade Debtors' }, { value: '9,000.00' }, { value: '0.00' }] },
      ] },
    ] },
    { rowType: 'Section', title: 'Liabilities', rows: [
      { rowType: 'Section', title: 'Current Liabilities', rows: [
        { rowType: 'Row', cells: [{ value: 'Payroll Clearing' }, { value: '-40.50' }, { value: '0.00' }] },
        { rowType: 'Row', cells: [{ value: "Director's Loan Account 2" }, { value: '-12,500.00' }, { value: '0.00' }] },
        { rowType: 'Row', cells: [{ value: "Director's Loan Account 3" }, { value: '800.00' }, { value: '0.00' }] },
        { rowType: 'Row', cells: [{ value: 'Suspense Old' }, { value: '0.00' }, { value: '0.00' }] },
      ] },
    ] },
  ],
};

test('suspenseOpenBalances finds suspense and clearing accounts with a balance, in any section', () => {
  const out = suspenseOpenBalances(bsReport, { asOf: '2026-10-08' });
  assert.deepEqual(out.map(i => [i.accountCode, i.amount]), [['Suspense', 250], ['Payroll Clearing', 40.5]]);
});

test('directorsLoanAlerts: overdrawn is a debit in an asset section and a negative in a liability section', () => {
  const { directorsLoanAlerts } = require('../src/services/journalChecks');
  const out = directorsLoanAlerts(bsReport, { asOf: '2026-10-08' });
  assert.deepEqual(out.map(i => [i.accountCode, i.amount, i.level]), [
    ['Director Loan Account', 4000, 'critical'],
    ["Director's Loan Account 2", 12500, 'critical'],
  ]);
  assert.match(out[1].description, /section 455/);
});

test('dividendStatus is silent when a dividend posting exists in the year and flags when none does', () => {
  const { dividendStatus } = require('../src/services/journalChecks');
  const accts = [{ code: '905', name: 'Dividends Paid', _class: 'EQUITY' }, { code: '270', name: 'Dividend Income', _class: 'REVENUE' }];
  const year = { fyStart: '2026-04-01', fyEnd: '2027-03-31', profit: 25000 };
  assert.deepEqual(dividendStatus({ accounts: accts, lines: [{ accountCode: '905', date: '2026-06-30' }], ...year }), []);
  const none = dividendStatus({ accounts: accts, lines: [{ accountCode: '270', date: '2026-06-30' }, { accountCode: '905', date: '2025-12-01' }], ...year });
  assert.equal(none.length, 1);
  assert.equal(none[0].rule, 'no_dividend_evidence');
  assert.match(dividendStatus({ accounts: [], lines: [], ...year })[0].description, /No dividend account was found/);
});

test('historicalChanges flags post-filing changes to filed periods but not payments or later periods', () => {
  const { historicalChanges } = require('../src/services/journalChecks');
  const out = historicalChanges({
    madeUpTo: '2025-03-31', filingDate: '2025-12-01',
    journals: [
      { manualJournalID: 'j1', date: '2025-02-01', updatedDateUTC: '2026-02-01T10:00:00Z', journalLines: [{ lineAmount: 100 }, { lineAmount: -100 }] },
      { manualJournalID: 'j2', date: '2025-06-01', updatedDateUTC: '2026-02-01T10:00:00Z', journalLines: [] },
      { manualJournalID: 'j3', date: '2025-02-01', updatedDateUTC: '2025-11-01T10:00:00Z', journalLines: [] },
    ],
    invoices: [
      { invoiceID: 'i1', invoiceNumber: 'INV-1', date: '2025-01-10', updatedDateUTC: '2026-03-01', status: 'AUTHORISED', amountPaid: 0, total: 50 },
      { invoiceID: 'i2', invoiceNumber: 'INV-2', date: '2025-01-10', updatedDateUTC: '2026-03-01', status: 'PAID', amountPaid: 50, total: 50 },
      { invoiceID: 'i3', invoiceNumber: 'INV-3', date: '2025-01-10', updatedDateUTC: '2026-03-01', status: 'VOIDED', amountPaid: 0, total: 70 },
    ],
    bankTransactions: [{ bankTransactionID: 'b1', date: '2025-01-05', updatedDateUTC: '2026-01-01', status: 'DELETED', total: 20 }],
  });
  assert.deepEqual(out.map(i => i.documentId).sort(), ['b1', 'i1', 'i3', 'j1']);
  assert.deepEqual(historicalChanges({ journals: [{ manualJournalID: 'x', date: '2025-01-01', updatedDateUTC: '2026-01-01' }] }), []);
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

test('supplierPaymentSources flags suppliers paid from both a bank account and the director\'s loan account only', () => {
  const { supplierPaymentSources } = require('../src/services/journalChecks');
  const accts = [
    { code: '090', accountID: 'b1', name: 'Business Bank Account', type: 'BANK' },
    { code: '091', accountID: 'b2', name: 'Savings', type: 'BANK' },
    { code: '835', accountID: 'd1', name: "Director's Loan Account", type: 'CURRLIAB' },
    { code: '800', accountID: 'o1', name: 'Credit Card Clearing', type: 'CURRLIAB' },
  ];
  const A = { contactID: 'c1', name: 'Amazon' };
  const B = { contactID: 'c2', name: 'Tesco' };
  const C = { contactID: 'c3', name: 'Shell' };
  const pay = (contact, account, amount, extra = {}) => ({ status: 'AUTHORISED', paymentType: 'ACCPAYPAYMENT', date: '2026-06-01', amount, account, invoice: { contact, invoiceNumber: 'I1' }, ...extra });
  const out = supplierPaymentSources({
    accounts: accts,
    payments: [
      pay(A, { accountID: 'b1', code: '090', name: 'Business Bank Account' }, 100),
      pay(A, { accountID: 'd1', code: '835', name: "Director's Loan Account" }, 40),
      pay(B, { accountID: 'b1', code: '090', name: 'Business Bank Account' }, 50),
      pay(B, { accountID: 'b2', code: '091', name: 'Savings' }, 25),
      pay(C, { accountID: 'b1', code: '090', name: 'Business Bank Account' }, 70),
      pay(C, { accountID: 'o1', code: '800', name: 'Credit Card Clearing' }, 30),
      pay(A, { accountID: 'd1', code: '835', name: "Director's Loan Account" }, 999, { status: 'DELETED' }),
    ],
    bankSpend: [{ status: 'AUTHORISED', type: 'SPEND', contact: C, bankAccount: { accountID: 'd1', code: '835', name: 'Director loan' }, total: 12, date: '2026-06-02' }],
  });
  assert.deepEqual(out.map(i => i.name).sort(), ['Amazon', 'Shell']);
  const amazon = out.find(i => i.name === 'Amazon');
  assert.equal(amazon.bankAmount, 100);
  assert.equal(amazon.dlaAmount, 40);
  assert.equal(amazon.potentialValue, 40);
  assert.equal(amazon.transactions.length, 2);
  const shell = out.find(i => i.name === 'Shell');
  assert.equal(shell.dlaPayments, 1);
});

test('joiningEstimates only suggests schemes to standard-scheme clients and only within the joining limits', () => {
  const { joiningEstimates } = require('../src/services/journalChecks');
  assert.deepEqual(joiningEstimates({ scheme: 'standard', taxableNet: 120000 }).map(r => r.rule), ['flat_rate_join', 'cash_annual_join']);
  assert.deepEqual(joiningEstimates({ scheme: 'standard', taxableNet: 150001 }).map(r => r.rule), ['cash_annual_join']);
  assert.deepEqual(joiningEstimates({ scheme: 'standard', taxableNet: 1350001 }), []);
  for (const scheme of ['unregistered', 'flat_rate', 'cash', 'annual']) assert.deepEqual(joiningEstimates({ scheme, taxableNet: 50000 }), []);
  assert.match(joiningEstimates({ scheme: 'standard', taxableNet: 100000 })[0].message, /VAT group/);
});

test('dividendStatus stays silent when the company has not made a profit', () => {
  const { dividendStatus } = require('../src/services/journalChecks');
  const base = { accounts: [], lines: [], fyStart: '2026-04-01', fyEnd: '2027-03-31' };
  assert.deepEqual(dividendStatus({ ...base, profit: 0 }), []);
  assert.deepEqual(dividendStatus({ ...base, profit: -500 }), []);
  assert.deepEqual(dividendStatus({ ...base, profit: null }), []);
  assert.match(dividendStatus({ ...base, profit: 1200 })[0].description, /profit of £1,200/);
});

test('Drawings and director-named loan accounts are recognised as the director loan account', () => {
  const { directorsLoanAlerts, netProfitFromReport } = require('../src/services/journalChecks');
  const rep = { rows: [{ rowType: 'Section', title: 'Assets', rows: [
    { rowType: 'Row', cells: [{ value: 'Drawings' }, { value: '300' }] },
    { rowType: 'Row', cells: [{ value: 'Director\'s Loan Account – J Smith' }, { value: '1,000' }] },
  ] }] };
  assert.deepEqual(directorsLoanAlerts(rep).map(i => i.accountCode), ['Drawings', 'Director\'s Loan Account – J Smith']);
  assert.equal(netProfitFromReport({ rows: [{ rowType: 'Section', rows: [{ rowType: 'Row', cells: [{ value: 'Net Profit' }, { value: '4,321.50' }] }] }] }), 4321.5);
});

test('a Drawings account in the equity section is not treated as an overdrawn director loan', () => {
  const { directorsLoanAlerts } = require('../src/services/journalChecks');
  const rep = { rows: [{ rowType: 'Section', title: 'Equity', rows: [{ rowType: 'Row', cells: [{ value: 'Owner A Drawings' }, { value: '-5,000' }] }] }] };
  assert.deepEqual(directorsLoanAlerts(rep), []);
});

test("the director loan account is recognised whatever the apostrophe style", () => {
  const { directorsLoanAlerts } = require('../src/services/journalChecks');
  for (const name of ["Directors' Loan Account", "Director's Loan Account", 'Directors’ Loan Account', 'Directors Loan Account', 'Director Loan', 'Directors Current Account']) {
    const rep = { rows: [{ rowType: 'Section', title: 'Current Liabilities', rows: [{ rowType: 'Row', cells: [{ value: name }, { value: '-500' }] }] }] };
    assert.equal(directorsLoanAlerts(rep).length, 1, name);
  }
});
