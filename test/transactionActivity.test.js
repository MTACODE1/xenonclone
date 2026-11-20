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

// ---- the sync's period calculation, as the reference ----
function referenceCounts(data, period) {
  const codes = new Set(data.chartOfAccounts.filter(a => a._class === 'REVENUE' && ['REVENUE', 'SALES'].includes(a.type)).map(a => a.code.toUpperCase()));
  const ids = new Set(data.chartOfAccounts.filter(a => a._class === 'REVENUE' && ['REVENUE', 'SALES'].includes(a.type)).map(a => a.accountID));
  const inPeriod = items => items.filter(item => isWithinPeriod(toDateString(item.date), period));
  const live = ['AUTHORISED', 'PAID', 'VOIDED'];
  const recentAccrec = inPeriod(data.invoices.filter(i => i.type === 'ACCREC' && live.includes(i.status)));
  const recentAccpay = inPeriod(data.invoices.filter(i => i.type === 'ACCPAY' && live.includes(i.status)));
  const recentSalesCN = inPeriod(data.credits.filter(c => c.type === 'ACCRECCREDIT')).filter(c => live.includes(c.status));
  const recentPurchaseCN = inPeriod(data.credits.filter(c => c.type === 'ACCPAYCREDIT')).filter(c => live.includes(c.status));
  const net = (line, doc) => (doc.lineAmountTypes === 'Inclusive' ? (line.lineAmount || 0) - (line.taxAmount || 0) : (line.lineAmount || 0)) / (doc.currencyRate || 1);
  const amount = (line, doc) => (line.accountCode && codes.has(line.accountCode.toUpperCase()) ? net(line, doc) : 0);
  let turnover = 0;
  for (const inv of recentAccrec.filter(i => i.status !== 'VOIDED')) for (const line of inv.lineItems || []) turnover += amount(line, inv);
  for (const cn of recentSalesCN.filter(c => c.status !== 'VOIDED')) for (const line of cn.lineItems || []) turnover -= amount(line, cn);
  const bank = type => data.bankTransactions.filter(b => b.type === type && b.status === 'AUTHORISED' && isWithinPeriod(toDateString(b.date), period));
  for (const bt of bank('RECEIVE')) for (const line of bt.lineItems || []) turnover += amount(line, bt);
  for (const bt of bank('SPEND')) for (const line of bt.lineItems || []) turnover -= amount(line, bt);
  turnover += turnoverAdjustmentFromPayments(data.payments, { revenueAccountIds: ids, revenueAccountCodes: codes, period });
  for (const mj of data.manualJournals.filter(j => j.status === 'POSTED' && isWithinPeriod(toDateString(j.date), period))) {
    for (const line of mj.journalLines || []) {
      if (!line.accountCode || !codes.has(line.accountCode.toUpperCase())) continue;
      turnover += -(mj.lineAmountTypes === 'Inclusive' ? (line.lineAmount || 0) - (line.taxAmount || 0) : (line.lineAmount || 0));
    }
  }
  const notVoided = item => item.status !== 'VOIDED';
  const counts = {
    customer_invoices: recentAccrec.filter(notVoided).length, supplier_bills: recentAccpay.filter(notVoided).length,
    credit_notes_sales: recentSalesCN.filter(notVoided).length, credit_notes_purchase: recentPurchaseCN.filter(notVoided).length,
    bank_processed: data.bankTransactions.filter(b => b.status === 'AUTHORISED' && isWithinPeriod(toDateString(b.date), period) && countsAsBankProcessed(b)).length,
    journals: data.journals.filter(j => isWithinPeriod(toDateString(j.journalDate), period)).length,
  };
  return { ...counts, turnover, total_transactions: counts.customer_invoices + counts.supplier_bills + counts.credit_notes_sales + counts.credit_notes_purchase + counts.bank_processed };
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
    payments: many(60, () => ({ status: pick(['AUTHORISED', 'DELETED']), date: xeroDate(day()), paymentType: pick(['ACCRECPAYMENT', 'ACCPAYPAYMENT']), amount: Math.abs(money()), bankAmount: pick([undefined, 55.5]), currencyRate: pick([undefined, 1.1]), account: pick([{ accountID: 'acc-090', code: '090' }, { accountID: 'acc-200', code: '200' }, { code: '260' }]) })),
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
      for (const field of ['customer_invoices', 'supplier_bills', 'credit_notes_sales', 'credit_notes_purchase', 'bank_processed', 'journals', 'total_transactions']) {
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
