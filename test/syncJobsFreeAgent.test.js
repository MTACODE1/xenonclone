const test = require('node:test');
const assert = require('node:assert/strict');

// Mocked MySQL pool: nothing here can touch the shared database.
const calls = [];
const fake = async (sql, params = []) => {
  calls.push({ sql, params });
  if (/SELECT id FROM akrio_organisations/i.test(sql)) {
    // Only a lookup that also searches freeagent_company_id finds this FreeAgent client (no Xero tenant id).
    return [/freeagent_company_id/i.test(sql) && params.includes('35963') ? [{ id: 390 }] : []];
  }
  if (/FROM akrio_sync_jobs WHERE org_id/i.test(sql)) return [[]];
  if (/^SELECT \* FROM akrio_sync_jobs WHERE id/i.test(sql)) return [[{ id: 'j1', org_id: 390, tenant_id: '35963', mode: 'full', status: 'queued', progress_json: '{}', payload_json: '{}', attempt: 0 }]];
  return [[], {}];
};
const poolPath = require.resolve('../src/db/mysqlPool');
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => ({ query: fake, getConnection: async () => ({ query: fake, release() {} }) }) } };
const { startJob } = require('../src/services/syncJobs');

test('Sync All can queue a FreeAgent client, which has no Xero tenant id', async () => {
  const started = await startJob('35963:all:since_lock_date::', async () => ({}), { tenantId: '35963', mode: 'full', payload: { period: { type: 'since_lock_date' } } });
  assert.ok(started.job, 'a job is created instead of "Organisation not found"');
  assert.ok(calls.some(c => /INSERT INTO akrio_sync_jobs/i.test(c.sql)));
});
