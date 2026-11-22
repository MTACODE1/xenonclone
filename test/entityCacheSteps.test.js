// The sync writes and reads the Xero cache in steps (mergeEntityCacheAsync / getCachedEntitiesAsync) so a large client
// does not hold the server. They must leave exactly what the one-step versions leave. A disposable SQLite file only:
// the MySQL copy is off (AKRIO_DB_USER unset), so nothing here can reach a shared database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.AKRIO_DB_USER;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akrio-cache-steps-'));
process.env.XERO_DASHBOARD_DB_PATH = path.join(dir, 'cache.db');
const { getDb } = require('../src/db/schema');
const {
  mergeEntityCache, mergeEntityCacheAsync, getCachedEntities, getCachedEntitiesAsync,
} = require('../src/db/queries');

function ensureOrg(id) {
  const db = getDb();
  db.pragma('foreign_keys = OFF');   // organisations live in MySQL now; the local FK has no rows to point at
  return id;
}
const tableFor = orgId => getDb().prepare(`
  SELECT entity_type, entity_id, json, modified_at, source_run_id FROM xero_entity_cache WHERE org_id = ? ORDER BY entity_type, entity_id
`).all(orgId);
const journals = (count, offset = 0) => Array.from({ length: count }, (_, n) => ({
  journalNumber: n + offset, journalDate: `2026-0${1 + (n % 9)}-1${n % 10}`, journalLines: [{ accountID: `a${n % 13}`, netAmount: -n }],
}));

test('stepwise cache write and read give exactly what the one-step versions give', async () => {
  const a = ensureOrg(9001); const b = ensureOrg(9002);
  // Same history on two clients: an earlier full load, then an incremental merge, then a full refresh that drops rows.
  for (const [orgId, merge] of [[a, async (...args) => mergeEntityCache(...args)], [b, mergeEntityCacheAsync]]) {
    await merge(orgId, 'journal', journals(4500), { runId: 1, fullRefresh: true });
    await merge(orgId, 'journal', journals(300, 4400), { runId: 2 });
    await merge(orgId, 'journal', journals(3100, 1500), { runId: 3, fullRefresh: true });
    await merge(orgId, 'contact', [{ contactID: 'x', name: 'X' }, { name: 'no id' }, { contactID: 'y', updatedDateUTC: '/Date(1767225600000+0000)/' }], { runId: 3 });
  }
  assert.deepEqual(tableFor(b), tableFor(a));
  assert.equal(tableFor(a).filter(row => row.entity_type === 'journal').length, 3100);
  for (const orgId of [a, b]) {
    assert.deepEqual(await getCachedEntitiesAsync(orgId, 'journal'), getCachedEntities(orgId, 'journal'));
    assert.deepEqual(await getCachedEntitiesAsync(orgId, 'contact'), getCachedEntities(orgId, 'contact'));
  }
  assert.deepEqual(await getCachedEntitiesAsync(a, 'payment'), []);
});

test('stepwise cache write lets timers run in between', async () => {
  const orgId = ensureOrg(9003);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  await mergeEntityCacheAsync(orgId, 'journal', journals(9000), { runId: 1, fullRefresh: true });
  const read = await getCachedEntitiesAsync(orgId, 'journal');
  clearInterval(timer);
  assert.equal(read.length, 9000);
  assert.ok(ticks > 0);
});

test('a failed stepwise write puts the watermark back so the next sync fetches the rows again', async () => {
  const orgId = ensureOrg(9004);
  await mergeEntityCacheAsync(orgId, 'journal', journals(10), { runId: 1, fullRefresh: true });
  const before = getDb().prepare(`SELECT MAX(fetched_at) AS w FROM xero_entity_cache WHERE org_id = ? AND entity_type = 'journal'`).get(orgId).w;
  await new Promise(resolve => setTimeout(resolve, 5));
  const rows = journals(2500, 100);
  // A row JSON.stringify cannot write (a BigInt) fails the second step, after the first 2,000 rows were saved.
  rows[2100].bad = 10n;
  await assert.rejects(mergeEntityCacheAsync(orgId, 'journal', rows, { runId: 2 }));
  const after = getDb().prepare(`SELECT MAX(fetched_at) AS w FROM xero_entity_cache WHERE org_id = ? AND entity_type = 'journal'`).get(orgId).w;
  assert.equal(after, before);
});

test.after(() => { try { getDb().close(); } catch (error) { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); });
