const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.tmpdir(), `snapshot-${process.pid}.db`);
process.env.XERO_DASHBOARD_DB_PATH = dbPath;
process.env.AKRIO_DB_USER = 'test-user';

// Minimal in-memory stand-in for the MySQL snapshot + lease tables.
const snap = []; // {table_name, chunk_no, row_count, data_hash, payload}
let lease = null;
const exec = async (sql, params = []) => {
  if (/^CREATE TABLE/i.test(sql)) return [[]];
  if (/^SELECT table_name, MAX/i.test(sql)) {
    const g = {};
    for (const r of snap) { g[r.table_name] = g[r.table_name] || { table_name: r.table_name, data_hash: r.data_hash, rows_total: 0 }; g[r.table_name].rows_total += r.row_count; }
    return [Object.values(g)];
  }
  if (/^SELECT payload/i.test(sql)) return [snap.filter(r => r.table_name === params[0]).sort((a, b) => a.chunk_no - b.chunk_no)];
  if (/^DELETE FROM akrio_sqlite_snapshot/i.test(sql)) { for (let i = snap.length - 1; i >= 0; i--) if (snap[i].table_name === params[0]) snap.splice(i, 1); return [[]]; }
  if (/^INSERT INTO akrio_sqlite_snapshot/i.test(sql)) {
    if (params.length === 3) snap.push({ table_name: params[0], chunk_no: 0, row_count: 0, data_hash: params[1], payload: params[2] });
    else snap.push({ table_name: params[0], chunk_no: params[1], row_count: params[2], data_hash: params[3], payload: params[4] });
    return [[]];
  }
  if (/FROM akrio_snapshot_lease/i.test(sql) && /^SELECT/i.test(sql)) return [lease ? [{ instance_id: lease.instance_id, live: lease.live ? 1 : 0 }] : []];
  if (/^INSERT INTO akrio_snapshot_lease/i.test(sql)) { lease = { instance_id: params[0], live: true }; return [[]]; }
  if (/^UPDATE akrio_snapshot_lease/i.test(sql)) { lease = { instance_id: params[0], live: true }; return [[]]; }
  if (/^DELETE FROM akrio_snapshot_lease/i.test(sql)) { lease = null; return [[]]; }
  return [[]];
};
const poolPath = require.resolve('../src/db/mysqlPool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: { getPool: () => ({ query: exec, getConnection: async () => ({
    query: exec, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
  }) }) },
};
const { getDb } = require('../src/db/schema');
const store = require('../src/db/snapshotStore');

test.after(() => { for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f); } catch (e) { /* none */ } } });

const addDismissal = key => getDb().prepare(
  "INSERT INTO finding_review_states (org_id, check_type, finding_key, state, notes) VALUES (1, 'old_unpaid_invoices', ?, 'dismissed', 'seen')"
).run(key);
const count = t => getDb().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

test('review work is saved to MySQL and restored after the local file is wiped', async () => {
  addDismissal('inv-1'); addDismissal('inv-2');
  getDb().prepare("INSERT INTO issues (org_id, check_type, importance, count) VALUES (1, 'x', 'high', 2)").run();
  await store.runCycle({ force: true });
  assert.ok(snap.some(r => r.table_name === 'finding_review_states' && r.row_count === 2));
  assert.ok(snap.some(r => r.table_name === 'issues'));

  getDb().prepare('DELETE FROM finding_review_states').run(); // simulate a fresh container
  getDb().prepare('DELETE FROM issues').run();
  store._resetForTests();
  const { restored } = await store.restoreSnapshots();
  assert.ok(restored >= 3);
  assert.equal(count('finding_review_states'), 2);
  assert.equal(count('issues'), 1);
  assert.equal(getDb().prepare("SELECT notes FROM finding_review_states WHERE finding_key = 'inv-2'").get().notes, 'seen');
});

test('a fresh empty container cannot overwrite the saved copy', async () => {
  getDb().prepare('DELETE FROM finding_review_states').run();
  store._resetForTests();
  lease = null;
  // Restore failed / not run: remote copy exists but this process has never seen rows.
  await store.runCycle();
  assert.ok(snap.some(r => r.table_name === 'finding_review_states' && r.row_count === 2), 'saved copy must survive');
});

test('a follower does not save and instead pulls the leader\'s changes', async () => {
  lease = { instance_id: 'someone-else', live: true };
  getDb().prepare('DELETE FROM finding_review_states').run();
  store._resetForTests();
  await store.runCycle();
  assert.equal(count('finding_review_states'), 2);
  assert.equal(lease.instance_id, 'someone-else');
});

test('large tables are split into several chunks and still round-trip', async () => {
  lease = null;
  const ins = getDb().prepare("INSERT INTO finding_notes (org_id, check_type, finding_key, notes) VALUES (1, 'c', ?, ?)");
  const big = 'x'.repeat(40000);
  getDb().transaction(() => { for (let i = 0; i < 200; i++) ins.run('k' + i, big + i); })();
  store._resetForTests();
  await store.restoreSnapshots();
  await store.runCycle();
  assert.ok(snap.filter(r => r.table_name === 'finding_notes').length > 1);
  getDb().prepare('DELETE FROM finding_notes').run();
  store._resetForTests();
  await store.restoreSnapshots();
  assert.equal(count('finding_notes'), 200);
});
