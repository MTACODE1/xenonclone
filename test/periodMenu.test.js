const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');
const { resolvePeriod, periodMenu, periodKeyLabel, storedPeriodLabel, ukDatesIn, isWithinPeriod } = require('../src/services/periodResolver');
const { ukDate } = require('../src/services/displayDate');

// A client with a 30 September year end and a lock date of 30/09/2025, viewed on 22/11/2026 (Xenon's own menu that day).
const CLIENT = { asOf: '2026-11-22', lockDate: '2025-09-30', lockSource: 'lock_date', financialYearEndDay: 30, financialYearEndMonth: 9 };

test('the period menu has Xenon\'s options, order and dates', () => {
  assert.deepEqual(periodMenu(CLIENT).map(option => option.label), [
    'All transactions', 'Current Month', 'Previous Month', 'Previous Month (and Earlier)', 'Rolling 12 months',
    'Rolling 24 months', 'Quarter Ended 30/11/2026', 'Quarter Ended 31/10/2026', 'Quarter Ended 30/09/2026',
    'Year Ended 30/09/2027', 'Year Ended 30/09/2026', 'Year Ended 30/09/2025', 'Since Xero Lock Date (30/09/2025)',
    'Custom Date Range',
  ]);
});

test('every option carries its full date range in UK order', () => {
  const titles = Object.fromEntries(periodMenu(CLIENT).map(option => [option.value, option.title]));
  assert.equal(titles.current_month, 'Current month (01/11/2026 to 22/11/2026)');
  assert.equal(titles.previous_month, 'Previous month (01/10/2026 to 31/10/2026)');
  assert.equal(titles.rolling_24_months, 'Rolling 24 months (23/11/2024 to 22/11/2026)');
  assert.equal(titles.quarter_ended_0, 'Quarter ended 30/11/2026 (01/09/2026 to 22/11/2026)');
  assert.equal(titles.previous_fy_2, 'Year ended 30/09/2025 (01/10/2024 to 30/09/2025)');
  for (const option of periodMenu(CLIENT)) assert.doesNotMatch(option.title, /\d{4}-\d{2}-\d{2}/);
});

test('new periods resolve to the right dates', () => {
  const at = type => { const p = resolvePeriod({ type }, CLIENT); return [p.start, p.end]; };
  assert.deepEqual(at('all_transactions'), ['2000-01-01', '2026-11-22']);
  assert.deepEqual(at('previous_month_and_earlier'), ['2000-01-01', '2026-10-31']);
  assert.deepEqual(at('rolling_24_months'), ['2024-11-23', '2026-11-22']);
  assert.deepEqual(at('quarter_ended_0'), ['2026-09-01', '2026-11-22']); // never past today
  assert.deepEqual(at('quarter_ended_1'), ['2026-08-01', '2026-10-31']);
  assert.deepEqual(at('quarter_ended_2'), ['2026-07-01', '2026-09-30']);
  assert.deepEqual(at('current_fy'), ['2026-10-01', '2026-11-22']);
  assert.deepEqual(at('previous_fy'), ['2025-10-01', '2026-09-30']);
  assert.deepEqual(at('previous_fy_2'), ['2024-10-01', '2025-09-30']);
});

test('existing periods keep their dates', () => {
  const at = type => { const p = resolvePeriod({ type }, CLIENT); return [p.start, p.end]; };
  assert.deepEqual(at('since_lock_date'), ['2025-09-30', '2026-11-22']);
  assert.deepEqual(at('previous_month'), ['2026-10-01', '2026-10-31']);
  assert.deepEqual(at('rolling_12_months'), ['2025-11-23', '2026-11-22']);
});

test('quarters across a year boundary and a March year end', () => {
  const jan = { ...CLIENT, asOf: '2027-01-15', financialYearEndDay: 31, financialYearEndMonth: 3 };
  const q = type => { const p = resolvePeriod({ type }, jan); return [p.start, p.end]; };
  assert.deepEqual(q('quarter_ended_0'), ['2026-11-01', '2027-01-15']);
  assert.deepEqual(q('quarter_ended_1'), ['2026-10-01', '2026-12-31']);
  assert.deepEqual(q('quarter_ended_2'), ['2026-09-01', '2026-11-30']);
  assert.deepEqual(periodMenu(jan).filter(o => o.value.endsWith('fy') || o.value === 'previous_fy_2').map(o => o.label),
    ['Year Ended 31/03/2027', 'Year Ended 31/03/2026', 'Year Ended 31/03/2025']);
});

test('only the since-lock-date period leaves out its first day', () => {
  const quarter = resolvePeriod({ type: 'quarter_ended_1' }, CLIENT);
  assert.equal(isWithinPeriod('2026-08-01', quarter), true);
  assert.equal(isWithinPeriod('2026-07-31', quarter), false);
});

test('stored labels and keys are shown with UK dates', () => {
  assert.equal(ukDatesIn('Current month (2026-11-01 to 2026-11-22)'), 'Current month (01/11/2026 to 22/11/2026)');
  assert.equal(storedPeriodLabel({ period_label: 'Previous financial year (2025-10-01 to 2026-09-30)' }), 'Previous financial year (01/10/2025 to 30/09/2026)');
  assert.equal(storedPeriodLabel({ period_key: 'quarter_ended_1:2026-08-01:2026-10-31' }), 'Quarter (01/08/2026 to 31/10/2026)');
  assert.equal(periodKeyLabel('all_transactions:2000-01-01:2026-11-22'), 'All transactions (01/01/2000 to 22/11/2026)');
});

test('ukDate shows dates and times the UK way and leaves other values alone', () => {
  assert.equal(ukDate('2026-11-21'), '21/11/2026');
  assert.equal(ukDate(new Date('2026-11-21T00:00:00Z')), '21/11/2026');
  assert.equal(ukDate('2026-07-01T09:30:00Z'), '01/07/2026 10:30'); // British Summer Time
  assert.equal(ukDate('2026-11-21T14:05:00.000Z'), '21/11/2026 14:05');
  assert.equal(ukDate('2026-11-21 08:15:00'), '21/11/2026 08:15');
  assert.equal(ukDate('Nov 20'), 'Nov 20');
  assert.equal(ukDate(null), null);
  assert.equal(ukDate(''), '');
});

test('bank lines page shows transaction dates as DD/MM/YYYY', async () => {
  const fs = require('fs');
  const source = fs.readFileSync(path.join(__dirname, '../src/views/bankLines.ejs'), 'utf8');
  assert.match(source, /ukDate\(r\.txn_date\)/);
  const html = await ejs.render('<%= typeof ukDate === "function" ? ukDate(d) : d %>', { ukDate, d: '2026-03-12' });
  assert.equal(html, '12/03/2026');
});

test('per-month figures use whole months, as Xenon does', () => {
  const months = type => resolvePeriod({ type }, CLIENT).monthsCovered;
  assert.equal(months('previous_fy'), 12);       // a year is 12 months in Xenon's /mth figures
  assert.equal(months('rolling_12_months'), 12);
  assert.equal(months('current_month'), 1);      // 22 days still counts as one month: 8 bills = 8/mth
  assert.equal(months('current_fy'), 2);       // this client's year started 01/10/2026
  assert.equal(months('quarter_ended_1'), 3);
});

test('credit-note, overpayment and prepayment refunds count with customer or supplier payments', () => {
  const { paymentSide } = require('../src/services/transactionActivity');
  assert.equal(paymentSide('ARCREDITPAYMENT'), 'customer');
  assert.equal(paymentSide('AROVERPAYMENTPAYMENT'), 'customer');
  assert.equal(paymentSide('ACCRECPAYMENT'), 'customer');
  assert.equal(paymentSide('APCREDITPAYMENT'), 'supplier');
  assert.equal(paymentSide('ACCPAYPAYMENT'), 'supplier');
  assert.equal(paymentSide('SOMETHINGELSE'), 'other');
});
