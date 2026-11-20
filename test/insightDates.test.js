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
