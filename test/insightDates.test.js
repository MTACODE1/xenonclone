// Insight "show data up to <date>": figures for a chosen date are stored beside the normal ones and never
// replace them. Throwaway SQLite; MySQL is blocked. Made-up figures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akrio-insight-dates-'));
process.env.XERO_DASHBOARD_DB_PATH = path.join(dir, 'test.db');
const poolPath = require.resolve('../src/db/mysqlPool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: { getPool: () => { throw new Error('MySQL is not available in this test'); } },
};
const queries = require('../src/db/queries');
const { getDb } = require('../src/db/schema');
const { RESULT_TABLES } = require('../src/db/snapshotStore');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('dated figures sit beside the latest ones; settings apply to both; one client never sees another\'s', () => {
  getDb();
  const ORG = 41;
  queries.saveInsightData(ORG, 'pnl', { months: ['latest'] });
  queries.saveInsightData(ORG, 'balance_sheet', { cash: 100 });
  queries.saveInsightData(ORG, 'target', { monthly_target: 5000 });
  queries.saveInsightData(ORG, 'pnl@2026-10-31', { months: ['october'] });
  queries.saveInsightData(ORG, 'meta@2026-10-31', { toDate: '2026-10-31', errors: [] });
  queries.saveInsightData(ORG + 1, 'pnl@2026-09-30', { months: ['other client'] });

  const latest = queries.getAllInsightData(ORG);
  assert.deepEqual(latest.pnl.data, { months: ['latest'] });
  assert.deepEqual(latest.balance_sheet.data, { cash: 100 });
  assert.equal(latest.meta, undefined);
  assert.deepEqual(latest.target.data, { monthly_target: 5000 });

  const october = queries.getAllInsightData(ORG, '2026-10-31');
  assert.deepEqual(october.pnl.data, { months: ['october'] });
  assert.equal(october.balance_sheet, undefined, 'the latest balance sheet is never shown as if it were October\'s');
  assert.deepEqual(october.target.data, { monthly_target: 5000 });
  assert.deepEqual(october.meta.data, { toDate: '2026-10-31', errors: [] });

  const notFetched = queries.getAllInsightData(ORG, '2026-09-30');
  assert.equal(notFetched.pnl, undefined);
  assert.deepEqual(notFetched.target.data, { monthly_target: 5000 });

  // Fetching a date again replaces that date only.
  queries.saveInsightData(ORG, 'pnl@2026-10-31', { months: ['october v2'] });
  assert.deepEqual(queries.getAllInsightData(ORG, '2026-10-31').pnl.data, { months: ['october v2'] });
  assert.deepEqual(queries.getAllInsightData(ORG).pnl.data, { months: ['latest'] });
});

test('Insight figures are among the results saved across deploys', () => {
  assert.ok(RESULT_TABLES.includes('insight_cache'));
  assert.ok(RESULT_TABLES.includes('transaction_daily') && RESULT_TABLES.includes('transaction_daily_meta'));
});

// Xero repeats the newest column's DAY RANGE in every earlier month, so only a range ending on the 31st gives
// whole months (seen live 21 Nov 2026: July income 8,857 as at 15 Nov, 36,844 as at 30 Sep, true 37,529).
const { monthlyPnlPlan, parseMonthHeader, wholeMonthsFrom, assembleMonthlyPnl } = require('../src/services/insightSync');

test('monthly P&L plan: the as-at month alone, then whole months anchored on a 31-day month', () => {
  // Mid-month in November (30 days). October has 31 days, so it anchors the rest.
  const nov = monthlyPnlPlan('2026-11-15');
  assert.deepEqual(nov.singles, [{ from: '2026-11-01', to: '2026-11-15', key: '2026-11' }]);
  assert.deepEqual({ from: nov.comparison.from, to: nov.comparison.to, periods: nov.comparison.periods }, { from: '2026-10-01', to: '2026-10-31', periods: 10 });
  assert.equal(nov.comparison.keys.length, 11);
  assert.deepEqual(nov.months.map(m => m.key), ['2026-11', '2026-10', '2026-09', '2026-08', '2026-07', '2026-06', '2026-05', '2026-04', '2026-03', '2026-02', '2026-01', '2025-12']);
  // July: the month before (June) has 30 days, so June is fetched alone and May (31) anchors the rest.
  const jul = monthlyPnlPlan('2026-07-31');
  assert.deepEqual(jul.singles, [{ from: '2026-07-01', to: '2026-07-31', key: '2026-07' }, { from: '2026-06-01', to: '2026-06-30', key: '2026-06' }]);
  assert.deepEqual({ from: jul.comparison.from, to: jul.comparison.to, periods: jul.comparison.periods }, { from: '2026-05-01', to: '2026-05-31', periods: 9 });
  // March: February is short (and 29 days in a leap year), January anchors; the year boundary is crossed.
  const mar = monthlyPnlPlan('2024-03-10');
  assert.deepEqual(mar.singles[1], { from: '2024-02-01', to: '2024-02-29', key: '2024-02' });
  assert.equal(mar.comparison.to, '2024-01-31');
  assert.equal(mar.months[11].key, '2023-04');
  // Every plan anchors on a 31-day month and covers twelve different months exactly once.
  for (let m = 1; m <= 12; m++) {
    const plan = monthlyPnlPlan(`2026-${String(m).padStart(2, '0')}-09`);
    assert.equal(plan.comparison.to.slice(8), '31');
    const covered = [...plan.singles.map(x => x.key), ...plan.comparison.keys];
    assert.deepEqual(covered, plan.months.map(x => x.key));
    assert.equal(new Set(covered).size, 12);
    assert.equal(plan.comparison.periods + 1, plan.comparison.keys.length);
  }
});

test('a column that does not end on its month\'s last day is not accepted as a whole month', () => {
  const plan = monthlyPnlPlan('2026-11-15');
  assert.deepEqual(parseMonthHeader('30 Sep 26'), { key: '2026-09', day: 30 });
  assert.equal(parseMonthHeader('Sep-26'), null);
  // Oldest first, as parsePnL returns them. August is cut at the 30th: it must be reported missing.
  const parsed = { headers: ['30 Aug 26', '30 Sep 26', '31 Oct 26'], totalIncome: [1, 2, 3], grossProfit: [1, 2, 3], netProfit: [0, 1, 2] };
  const { whole, missing } = wholeMonthsFrom(parsed, plan);
  assert.deepEqual([...whole.keys()].sort(), ['2026-09', '2026-10']);
  assert.ok(missing.includes('2026-08'));
  assert.equal(missing.length, 9);
  const figures = new Map([['2026-11', { totalIncome: 9, grossProfit: 8, netProfit: 7 }], ...whole]);
  const result = assembleMonthlyPnl(plan, figures);
  assert.deepEqual(result.headers, ['30 Sep 26', '31 Oct 26', '15 Nov 26']); // oldest first; the as-at month ends on the as-at day
  assert.deepEqual(result.totalIncome, [2, 3, 9]);
});
