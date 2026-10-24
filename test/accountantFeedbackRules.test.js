// Accountant feedback, v3/v4 workbooks (Oct 2026): pure rules, offline, synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  balanceSheetNeeded, nonCompanyDividendIssue, selectUnapprovedInPeriod, resolveCheckDisplayStatus, NON_SCORED_CHECKS,
  findDuplicates, BALANCE_SHEET_CHECK_TYPES, LIVE_ONLY_CHECK_TYPES,
} = require('../src/services/checkRules');
const { resolvePeriod } = require('../src/services/periodResolver');

test('the Balance Sheet is requested for every live run, a cache-only full run, and cache-only runs of the checks that read it', () => {
  assert.equal(balanceSheetNeeded({}), true, 'a normal live sync');
  assert.equal(balanceSheetNeeded({ cacheOnly: false, checkType: 'multi_tax_suppliers' }), true, 'live single-check runs behave as before');
  assert.equal(balanceSheetNeeded({ cacheOnly: true }), true, 'a cache-only recalculation for another period');
  for (const checkType of ['suspense_open_balance', 'directors_loan_overdrawn', 'motor_vehicle_expenses']) {
    assert.equal(balanceSheetNeeded({ cacheOnly: true, checkType }), true, checkType);
  }
  for (const checkType of ['multi_tax_suppliers', 'unapproved_invoices', 'purchase_tax_missing', 'dividend_status']) {
    assert.equal(balanceSheetNeeded({ cacheOnly: true, checkType }), false, `${checkType} needs no report`);
  }
  assert.equal(balanceSheetNeeded(), true, 'no options at all is a live run');
  assert.deepEqual([...BALANCE_SHEET_CHECK_TYPES].sort(), ['directors_loan_overdrawn', 'motor_vehicle_expenses', 'suspense_open_balance']);
});

test('Dividends is marked not applicable for a non-company, and the label survives as "Not applicable"', () => {
  const row = nonCompanyDividendIssue(42);
  assert.deepEqual(row, {
    org_id: 42, check_type: 'dividend_status', importance: 'medium', count: 0, potential_value_gbp: 0,
    detail_json: '[]', period_checked: 'not_a_company',
  });
  assert.equal(resolveCheckDisplayStatus({ ...row }), 'not_applicable');
  assert.ok(NON_SCORED_CHECKS.includes('dividend_status'), 'it never affects the score');
  assert.ok(LIVE_ONLY_CHECK_TYPES.includes('dividend_status'));
});

const sinceLock = resolvePeriod({ type: 'since_lock_date' }, { lockDate: '2026-03-31', asOf: '2026-10-24' });
const custom = resolvePeriod({ type: 'custom', from: '2026-04-01', to: '2026-09-30' }, { asOf: '2026-10-24' });
const draft = (id, date, status = 'DRAFT', extra = {}) => ({ invoiceID: id, status, date, total: 10, contact: { contactID: 'c1' }, ...extra });

test('Unapproved selection keeps in-period documents and undated drafts, and drops older, future and malformed dates', () => {
  const documents = [
    draft('in-period', '2026-06-15'), draft('before', '2026-03-31'), draft('before-2', '2025-12-01'),
    draft('undated-undefined', undefined), draft('undated-null', null), draft('undated-empty', ''), draft('undated-blank', '   '),
    draft('malformed', 'not a date'), draft('submitted-undated', undefined, 'SUBMITTED'), draft('after-end', '2026-10-30'),
    draft('xero-style', '/Date(1781481600000+0000)/'),
  ];
  const ids = selectUnapprovedInPeriod(documents, sinceLock).map(d => d.invoiceID);
  assert.deepEqual(ids, ['in-period', 'undated-undefined', 'undated-null', 'undated-empty', 'submitted-undated', 'xero-style'], 'a whitespace-only date is malformed, not undated');
});

test('period boundaries are unchanged: the lock date itself is out, a custom period includes its first day', () => {
  const edge = [draft('lock-day', '2026-03-31'), draft('day-after', '2026-04-01')];
  assert.deepEqual(selectUnapprovedInPeriod(edge, sinceLock).map(d => d.invoiceID), ['day-after']);
  assert.deepEqual(selectUnapprovedInPeriod([draft('first', '2026-04-01'), draft('last', '2026-09-30'), draft('over', '2026-10-01')], custom).map(d => d.invoiceID), ['first', 'last']);
});

test('the selection does not change the documents and does not invent a date', () => {
  const undated = draft('u', undefined);
  const [kept] = selectUnapprovedInPeriod([undated], sinceLock);
  assert.equal(kept, undated);
  assert.equal(kept.date, undefined);
  assert.deepEqual(selectUnapprovedInPeriod([], sinceLock), []);
});

test('undated drafts never form duplicate groups (the date window needs dates), so they stay separate counted documents', () => {
  const a = draft('a', undefined, 'DRAFT', { invoiceNumber: 'INV-1' });
  const b = draft('b', undefined, 'DRAFT', { invoiceNumber: 'INV-1' });
  assert.deepEqual(findDuplicates([a, b]), []);
  assert.deepEqual(findDuplicates([draft('c', '2026-06-01', 'DRAFT', { invoiceNumber: 'INV-1' }), b]), [], 'a dated and an undated draft do not pair either');
  const dated = findDuplicates([draft('c', '2026-06-01', 'DRAFT', { invoiceNumber: 'INV-1' }), draft('d', '2026-06-02', 'DRAFT', { invoiceNumber: 'INV-1' })]);
  assert.deepEqual(dated.map(group => group.documentIds), [['c', 'd']], 'dated duplicates are still found as before');
});

// ---- Turnover and payments posted to a revenue account (Eat Drink Live Well: Akrio £150 higher than Xero's P&L) ----
const { turnoverAdjustmentFromPayments } = require('../src/services/checkRules');

const REVENUE_ID = 'acct-sales-clinic';
const ctx = { revenueAccountIds: new Set([REVENUE_ID]), revenueAccountCodes: new Set(['201']), period: custom };
const payment = (extra = {}) => ({
  paymentID: 'p1', status: 'AUTHORISED', paymentType: 'ACCRECPAYMENT', date: '2026-06-15', amount: 150,
  account: { accountID: REVENUE_ID }, ...extra,
});

test('a customer payment made from a revenue account reduces turnover by its amount', () => {
  assert.equal(turnoverAdjustmentFromPayments([payment()], ctx), -150);
  assert.equal(turnoverAdjustmentFromPayments([payment(), payment({ paymentID: 'p2', amount: 30.5 })], ctx), -180.5);
});

test('a supplier payment from a revenue account is a credit to revenue and increases turnover', () => {
  assert.equal(turnoverAdjustmentFromPayments([payment({ paymentType: 'ACCPAYPAYMENT', amount: 40 })], ctx), 40);
});

test('payments from bank or other accounts, deleted payments, other payment types and out-of-period dates are ignored', () => {
  const ignored = [
    payment({ account: { accountID: 'acct-bank' } }),
    payment({ status: 'DELETED' }),
    payment({ paymentType: 'ARCREDITPAYMENT' }),
    payment({ paymentType: 'AROVERPAYMENTPAYMENT' }),
    payment({ date: '2026-03-31' }),   // the day before this custom period starts
    payment({ date: '2026-10-01' }),   // after it ends
    payment({ date: undefined }),
    payment({ account: undefined }),
  ];
  assert.equal(turnoverAdjustmentFromPayments(ignored, ctx), 0);
  assert.equal(turnoverAdjustmentFromPayments([], ctx), 0);
  assert.equal(turnoverAdjustmentFromPayments(undefined, ctx), 0);
});

test('the account can be matched by id or by code (case-insensitive); the base-currency amount is used when there is one', () => {
  assert.equal(turnoverAdjustmentFromPayments([payment({ account: { code: '201' } })], ctx), -150);
  const codeCtx = { ...ctx, revenueAccountCodes: new Set(['SALES-A']) };
  assert.equal(turnoverAdjustmentFromPayments([payment({ account: { code: 'sales-a' } })], codeCtx), -150);
  assert.equal(turnoverAdjustmentFromPayments([payment({ amount: 200, bankAmount: 160 })], ctx), -160, 'bank (base) amount first');
  assert.equal(turnoverAdjustmentFromPayments([payment({ amount: 200, currencyRate: 2 })], ctx), -100, 'else converted at the payment rate');
  assert.equal(turnoverAdjustmentFromPayments([payment({ amount: 'x' })], ctx), 0, 'a non-numeric amount counts as nothing');
});

test('period boundaries match the rest of turnover: a since-lock-date period excludes its start day', () => {
  const since = { ...ctx, period: sinceLock };
  assert.equal(turnoverAdjustmentFromPayments([payment({ date: '2026-03-31' }), payment({ date: '2026-04-01' })], since), -150);
});

test('GUARD: the sync adds the payment adjustment to turnover', () => {
  const fs = require('node:fs'), path = require('node:path');
  const sync = fs.readFileSync(path.join(__dirname, '../src/services/xeroSync.js'), 'utf8');
  assert.match(sync, /turnover \+= turnoverAdjustmentFromPayments\(matchingPayments, \{\s*revenueAccountIds: turnoverAccountIds, revenueAccountCodes: turnoverAccountCodes, period,/);
});

test('REGRESSION: a malformed date (whitespace or text) never makes two drafts look like duplicates and hide a valid one', () => {
  const valid = draft('valid', '2026-06-01', 'DRAFT', { invoiceNumber: 'A', total: 100 });
  for (const bad of ['   ', 'not a date', '31/31/2026']) {
    const odd = draft('odd', bad, 'DRAFT', { invoiceNumber: 'B', total: 100 });
    assert.deepEqual(findDuplicates([valid, odd]), [], `no duplicate group from ${JSON.stringify(bad)}`);
    const selected = selectUnapprovedInPeriod([valid, odd], custom);
    assert.deepEqual(selected.map(d => d.invoiceID), ['valid'], 'the malformed one is left out, the valid one stays counted');
    assert.deepEqual(findDuplicates(selected), []);
  }
});
