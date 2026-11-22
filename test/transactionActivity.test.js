// Per-day transaction figures (transactionActivity.js): adding the days of ANY period back up must give exactly
// what the sync's own transaction-count step computes for that period. The reference below is that step's
// logic (xeroSync.js), kept here as the yardstick. SQLite runs on a throwaway file; MySQL is blocked. Made-up data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akrio-tx-daily-'));
process.env.XERO_DASHBOARD_DB_PATH = path.join(dir, 'test.db');
const poolPath = require.resolve('../src/db/mysqlPool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: { getPool: () => { throw new Error('MySQL is not available in this test'); } },
};

const { buildDailyActivity, sumActivity } = require('../src/services/transactionActivity');
const { toDateString, countsAsBankProcessed, turnoverAdjustmentFromPayments } = require('../src/services/checkRules');
const { isWithinPeriod, resolvePeriod } = require('../src/services/periodResolver');
const queries = require('../src/db/queries');
const { getDb } = require('../src/db/schema');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ---- the reference: turnover exactly as the sync's own step works it out, and counts by the stated rules ----
// Counts follow Xenon's Transaction Counts (see transactionActivity.js): drafts and awaiting-approval documents are
// counted, Bank Processed = customer payments + supplier payments + direct deposits + direct payments + transfers,
// Journals = posted manual journals, and the total includes them.
function referenceCounts(data, period) {
  const codes = new Set(data.chartOfAccounts.filter(a => a._class === 'REVENUE' && ['REVENUE', 'SALES'].includes(a.type)).map(a => a.code.toUpperCase()));
  const ids = new Set(data.chartOfAccounts.filter(a => a._class === 'REVENUE' && ['REVENUE', 'SALES'].includes(a.type)).map(a => a.accountID));
  const inPeriod = items => items.filter(item => isWithinPeriod(toDateString(item.date), period));
  const posted = ['AUTHORISED', 'PAID'];
  const counted = ['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID'];
  const net = (line, doc) => (doc.lineAmountTypes === 'Inclusive' ? (line.lineAmount || 0) - (line.taxAmount || 0) : (line.lineAmount || 0)) / (doc.currencyRate || 1);
  const amount = (line, doc) => (line.accountCode && codes.has(line.accountCode.toUpperCase()) ? net(line, doc) : 0);
  let turnover = 0;
  for (const inv of inPeriod(data.invoices.filter(i => i.type === 'ACCREC' && posted.includes(i.status)))) for (const line of inv.lineItems || []) turnover += amount(line, inv);
  for (const cn of inPeriod(data.credits.filter(c => c.type === 'ACCRECCREDIT' && posted.includes(c.status)))) for (const line of cn.lineItems || []) turnover -= amount(line, cn);
  const bank = type => data.bankTransactions.filter(b => b.type === type && b.status === 'AUTHORISED' && isWithinPeriod(toDateString(b.date), period));
  for (const bt of bank('RECEIVE')) for (const line of bt.lineItems || []) turnover += amount(line, bt);
  for (const bt of bank('SPEND')) for (const line of bt.lineItems || []) turnover -= amount(line, bt);
  turnover += turnoverAdjustmentFromPayments(data.payments, { revenueAccountIds: ids, revenueAccountCodes: codes, period });
  const postedJournals = data.manualJournals.filter(j => j.status === 'POSTED' && isWithinPeriod(toDateString(j.date), period));
  for (const mj of postedJournals) {
    for (const line of mj.journalLines || []) {
      if (!line.accountCode || !codes.has(line.accountCode.toUpperCase())) continue;
      turnover += -(mj.lineAmountTypes === 'Inclusive' ? (line.lineAmount || 0) - (line.taxAmount || 0) : (line.lineAmount || 0));
    }
  }
  const docs = (list, type) => inPeriod(list.filter(d => d.type === type && counted.includes(d.status))).length;
  const liveBank = data.bankTransactions.filter(b => b.status === 'AUTHORISED' && isWithinPeriod(toDateString(b.date), period) && countsAsBankProcessed(b));
  const livePayments = data.payments.filter(p => p.status === 'AUTHORISED' && isWithinPeriod(toDateString(p.date), period));
  const counts = {
    customer_invoices: docs(data.invoices, 'ACCREC'), supplier_bills: docs(data.invoices, 'ACCPAY'),
    credit_notes_sales: docs(data.credits, 'ACCRECCREDIT'), credit_notes_purchase: docs(data.credits, 'ACCPAYCREDIT'),
    customer_payments: livePayments.filter(p => /^(ACCREC|AR)/.test(p.paymentType)).length,
    supplier_payments: livePayments.filter(p => /^(ACCPAY|AP)/.test(p.paymentType)).length,
    other_payments: livePayments.filter(p => !/^(ACCREC|AR|ACCPAY|AP)/.test(p.paymentType)).length,
    direct_deposits: liveBank.filter(b => /^RECEIVE/.test(b.type) && !/-TRANSFER$/.test(b.type)).length,
    direct_payments: liveBank.filter(b => /^SPEND/.test(b.type) && !/-TRANSFER$/.test(b.type)).length,
    transfers: liveBank.filter(b => /-TRANSFER$/.test(b.type)).length,
    manual_journals: postedJournals.length,
    journals: data.journals.filter(j => isWithinPeriod(toDateString(j.journalDate), period)).length,
  };
  counts.bank_processed = counts.customer_payments + counts.supplier_payments + counts.direct_deposits + counts.direct_payments + counts.transfers;
  return { ...counts, turnover, total_transactions: counts.customer_invoices + counts.supplier_bills + counts.credit_notes_sales + counts.credit_notes_purchase + counts.bank_processed + counts.manual_journals };
}

// ---- made-up client data, from a seeded generator so a failure can be reproduced ----
function generator(seed) {
  let state = seed;
  const next = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
  const pick = list => list[Math.floor(next() * list.length)];
  const day = () => new Date(Date.UTC(2025, 0, 1) + Math.floor(next() * 700) * 86400000).toISOString().slice(0, 10);
  const xeroDate = iso => (next() < 0.5 ? iso : `/Date(${Date.parse(iso + 'T00:00:00Z')}+0000)/`); // both shapes Xero uses
  const money = () => Math.round((next() * 2000 - 200) * 100) / 100;
  const lines = () => Array.from({ length: 1 + Math.floor(next() * 3) }, () => ({ accountCode: pick(['200', '260', '001a', '400', '090', null]), lineAmount: money(), taxAmount: Math.round(next() * 5000) / 100 }));
  const doc = (types, statuses) => ({ type: pick(types), status: pick(statuses), date: xeroDate(day()), lineAmountTypes: pick(['Exclusive', 'Inclusive', 'NoTax']), currencyRate: pick([undefined, 1, 1.27, 0.86]), lineItems: lines() });
  const many = (n, make) => Array.from({ length: n }, make);
  return {
    chartOfAccounts: [
      { code: '200', accountID: 'acc-200', _class: 'REVENUE', type: 'REVENUE' }, { code: '260', accountID: 'acc-260', _class: 'REVENUE', type: 'SALES' },
      { code: '001A', accountID: 'acc-001a', _class: 'REVENUE', type: 'REVENUE' }, { code: '270', accountID: 'acc-270', _class: 'REVENUE', type: 'OTHERINCOME' },
      { code: '400', accountID: 'acc-400', _class: 'EXPENSE', type: 'EXPENSE' }, { code: '090', accountID: 'acc-090', _class: 'ASSET', type: 'BANK' },
    ],
    invoices: many(140, () => doc(['ACCREC', 'ACCPAY'], ['AUTHORISED', 'PAID', 'VOIDED', 'DRAFT', 'SUBMITTED', 'DELETED'])),
    credits: many(40, () => doc(['ACCRECCREDIT', 'ACCPAYCREDIT'], ['AUTHORISED', 'PAID', 'VOIDED', 'DRAFT'])),
    bankTransactions: many(160, () => ({ ...doc(['SPEND', 'RECEIVE', 'SPEND-TRANSFER', 'RECEIVE-TRANSFER'], ['AUTHORISED', 'DELETED']), total: pick([0, 0.004, 12.5, 300]) })),
    manualJournals: many(30, () => ({ status: pick(['POSTED', 'DRAFT', 'VOIDED']), date: xeroDate(day()), lineAmountTypes: pick(['NoTax', 'Inclusive']), journalLines: lines() })),
    payments: many(60, () => ({ status: pick(['AUTHORISED', 'DELETED']), date: xeroDate(day()), paymentType: pick(['ACCRECPAYMENT', 'ACCPAYPAYMENT', 'ARCREDITPAYMENT', 'APPREPAYMENTPAYMENT']), amount: Math.abs(money()), bankAmount: pick([undefined, 55.5]), currencyRate: pick([undefined, 1.1]), account: pick([{ accountID: 'acc-090', code: '090' }, { accountID: 'acc-200', code: '200' }, { code: '260' }]) })),
    journals: many(200, () => ({ journalDate: xeroDate(day()) })),
  };
}

const CONTEXT = { asOf: '2026-11-20', lockDate: '2026-03-31', lockSource: 'lock_date', financialYearEndDay: 31, financialYearEndMonth: 3 };
const PERIODS = [
  { type: 'since_lock_date' }, { type: 'current_month' }, { type: 'previous_month' }, { type: 'rolling_12_months' },
  { type: 'current_fy' }, { type: 'previous_fy' }, { type: 'custom', from: '2025-06-15', to: '2025-06-15' },
  { type: 'custom', from: '2025-01-01', to: '2026-11-20' }, { type: 'custom', from: '2026-02-28', to: '2026-03-01' },
];

test('for every period type, the days added up equal the sync\'s own calculation for that period', () => {
  for (const seed of [1, 7, 20261120]) {
    const data = generator(seed);
    const daily = buildDailyActivity(data);
    assert.equal(daily.journalsKnown, true);
    for (const input of PERIODS) {
      const period = resolvePeriod(input, CONTEXT);
      const expected = referenceCounts(data, period);
      const got = sumActivity(daily.rows, period);
      for (const field of ['customer_invoices', 'supplier_bills', 'credit_notes_sales', 'credit_notes_purchase', 'customer_payments', 'supplier_payments', 'other_payments', 'direct_deposits', 'direct_payments', 'transfers', 'bank_processed', 'manual_journals', 'journals', 'total_transactions']) {
        assert.equal(got[field], expected[field], `${field} for ${period.key} (seed ${seed})`);
      }
      assert.ok(Math.abs(got.turnover - expected.turnover) < 0.005, `turnover for ${period.key} (seed ${seed}): ${got.turnover} vs ${expected.turnover}`);
      assert.equal(got.period_start, period.start);
      assert.equal(got.months_covered, period.monthsCovered);
    }
  }
});

test('a "since lock date" period leaves out the lock date itself; other periods include both ends', () => {
  const data = {
    chartOfAccounts: [{ code: '200', accountID: 'a', _class: 'REVENUE', type: 'REVENUE' }],
    invoices: ['2026-03-31', '2026-04-01', '2026-04-30'].map(date => ({ type: 'ACCREC', status: 'PAID', date, lineItems: [{ accountCode: '200', lineAmount: 100 }] })),
  };
  const { rows } = buildDailyActivity(data);
  const sinceLock = sumActivity(rows, resolvePeriod({ type: 'since_lock_date' }, CONTEXT));
  assert.equal(sinceLock.customer_invoices, 2);
  assert.equal(sinceLock.turnover, 200);
  const custom = sumActivity(rows, resolvePeriod({ type: 'custom', from: '2026-03-31', to: '2026-04-30' }, CONTEXT));
  assert.equal(custom.customer_invoices, 3);
  assert.equal(custom.turnover, 300);
});

test('when the journal download was skipped the journal count is unknown, not zero', () => {
  const daily = buildDailyActivity({ invoices: [{ type: 'ACCPAY', status: 'AUTHORISED', date: '2026-05-01' }], journals: null });
  assert.equal(daily.journalsKnown, false);
  const total = sumActivity(daily.rows, resolvePeriod({ type: 'current_fy' }, CONTEXT), { journalsKnown: false });
  assert.equal(total.journals, null);
  assert.equal(total.supplier_bills, 1);
});

test('stored per client: any period is read back without a sync, and one client never sees another\'s rows', () => {
  getDb();
  const data = generator(42);
  const daily = buildDailyActivity(data);
  queries.replaceTransactionDaily(501, daily.rows, { journalsKnown: true });
  queries.replaceTransactionDaily(502, buildDailyActivity(generator(43)).rows, { journalsKnown: true });
  for (const input of PERIODS) {
    const period = resolvePeriod(input, CONTEXT);
    const expected = referenceCounts(data, period);
    const got = queries.getTransactionActivityForOrg(501, period);
    assert.equal(got.source, 'daily');
    assert.equal(got.total_transactions, expected.total_transactions, period.key);
    assert.equal(got.journals, expected.journals, period.key);
    assert.ok(Math.abs(got.turnover - expected.turnover) < 0.005, period.key);
  }
  assert.equal(queries.getTransactionActivityForOrg(999, resolvePeriod({ type: 'current_month' }, CONTEXT)), null);
});

test('a later sync without journals keeps the journal counts already known and replaces everything else', () => {
  const first = buildDailyActivity({
    invoices: [{ type: 'ACCREC', status: 'PAID', date: '2026-05-01' }],
    journals: [{ journalDate: '2026-05-01' }, { journalDate: '2026-05-02' }, { journalDate: '2026-05-02' }],
  });
  queries.replaceTransactionDaily(601, first.rows, { journalsKnown: true });
  const second = buildDailyActivity({ invoices: [{ type: 'ACCREC', status: 'PAID', date: '2026-05-03' }], journals: null });
  queries.replaceTransactionDaily(601, second.rows, { journalsKnown: false });
  const got = queries.getTransactionActivityForOrg(601, resolvePeriod({ type: 'custom', from: '2026-05-01', to: '2026-05-31' }, CONTEXT));
  assert.equal(got.customer_invoices, 1); // only the invoice of the second run
  assert.equal(got.journals, 3);          // journals from the first run are kept
  // A client whose journals were never downloaded shows unknown.
  queries.replaceTransactionDaily(602, second.rows, { journalsKnown: false });
  assert.equal(queries.getTransactionActivityForOrg(602, resolvePeriod({ type: 'current_fy' }, CONTEXT)).journals, null);
});

test('Xenon\'s counting rules: drafts counted, payments and transfers inside Bank Processed, manual journals in the total', () => {
  const day = '2026-10-10';
  const data = {
    chartOfAccounts: [{ code: '200', accountID: 'a', _class: 'REVENUE', type: 'REVENUE' }],
    invoices: [
      ...['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'VOIDED', 'DELETED'].map(status => ({ type: 'ACCREC', status, date: day, lineItems: [{ accountCode: '200', lineAmount: 100 }] })),
      { type: 'ACCPAY', status: 'DRAFT', date: day }, { type: 'ACCPAY', status: 'PAID', date: day },
      { type: 'ACCPAY', status: 'DRAFT', date: null }, // a draft with no date belongs to no period
    ],
    credits: [{ type: 'ACCRECCREDIT', status: 'DRAFT', date: day, lineItems: [{ accountCode: '200', lineAmount: 30 }] }, { type: 'ACCPAYCREDIT', status: 'VOIDED', date: day }],
    bankTransactions: [
      { type: 'RECEIVE', status: 'AUTHORISED', date: day, total: 50 }, { type: 'SPEND', status: 'AUTHORISED', date: day, total: 20 },
      { type: 'SPEND', status: 'AUTHORISED', date: day, total: 0 }, { type: 'SPEND', status: 'DELETED', date: day, total: 9 },
      { type: 'SPEND-TRANSFER', status: 'AUTHORISED', date: day, total: 70 }, { type: 'RECEIVE-TRANSFER', status: 'AUTHORISED', date: day, total: 70 },
      { type: 'RECEIVE-OVERPAYMENT', status: 'AUTHORISED', date: day, total: 5 },
    ],
    payments: [
      { status: 'AUTHORISED', date: day, paymentType: 'ACCRECPAYMENT', amount: 1 }, { status: 'AUTHORISED', date: day, paymentType: 'ACCRECPAYMENT', amount: 1 },
      { status: 'AUTHORISED', date: day, paymentType: 'ACCPAYPAYMENT', amount: 1 }, { status: 'DELETED', date: day, paymentType: 'ACCPAYPAYMENT', amount: 1 },
      { status: 'AUTHORISED', date: day, paymentType: 'ARCREDITPAYMENT', amount: 1 },
    ],
    manualJournals: [{ status: 'POSTED', date: day }, { status: 'DRAFT', date: day }],
    journals: [{ journalDate: day }, { journalDate: day }, { journalDate: day }],
  };
  const total = sumActivity(buildDailyActivity(data).rows, resolvePeriod({ type: 'custom', from: day, to: day }, CONTEXT));
  assert.equal(total.customer_invoices, 4);   // draft, awaiting approval, approved, paid
  assert.equal(total.supplier_bills, 2);
  assert.equal(total.credit_notes_sales, 1);
  assert.equal(total.credit_notes_purchase, 0);
  assert.equal(total.turnover, 200);          // only the approved and the paid invoice; the draft credit note takes nothing off
  assert.equal(total.customer_payments, 3);   // two invoice payments and one credit-note refund, as Xenon counts them
  assert.equal(total.supplier_payments, 1);
  assert.equal(total.other_payments, 0);
  assert.equal(total.direct_deposits, 2);     // RECEIVE and RECEIVE-OVERPAYMENT
  assert.equal(total.direct_payments, 1);     // the £0.00 and the deleted one are left out
  assert.equal(total.transfers, 2);           // one transfer, once on each side
  assert.equal(total.bank_processed, 9);
  assert.equal(total.manual_journals, 1);
  assert.equal(total.journals, 3);            // system journals: shown nowhere in the total
  assert.equal(total.total_transactions, 4 + 2 + 1 + 0 + 9 + 1);
});

test('per-day rows built with older counting rules are not shown', () => {
  getDb();
  queries.replaceTransactionDaily(701, buildDailyActivity(generator(5)).rows, { journalsKnown: true });
  const period = resolvePeriod({ type: 'rolling_12_months' }, CONTEXT);
  assert.equal(queries.getTransactionActivityForOrg(701, period).source, 'daily');
  getDb().prepare(`UPDATE transaction_daily_meta SET definition = 1 WHERE org_id = 701`).run();
  assert.equal(queries.getTransactionActivityForOrg(701, period), null);
});

test('labels show the first day a period counts: the day after the lock date for since-lock-date', () => {
  const { firstCountedDay, isWithinPeriod } = require('../src/services/periodResolver');
  const sinceLock = { type: 'since_lock_date', start: '2025-10-31', end: '2026-11-21' };
  assert.equal(firstCountedDay(sinceLock), '2025-11-01');
  assert.equal(isWithinPeriod('2025-10-31', sinceLock), false); // the locked day is not counted
  assert.equal(isWithinPeriod('2025-11-01', sinceLock), true);
  assert.equal(firstCountedDay({ type: 'previous_fy', start: '2025-11-01', end: '2026-10-31' }), '2025-11-01');
  assert.equal(firstCountedDay({ type: 'since_lock_date', start: '2025-12-31', end: '2026-11-21' }), '2026-01-01');
  assert.equal(firstCountedDay(null), null);
});
