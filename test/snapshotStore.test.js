const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.tmpdir(), `snapshot-${process.pid}.db`);
process.env.XERO_DASHBOARD_DB_PATH = dbPath;
process.env.AKRIO_DB_USER = 'test-user';
process.env.SNAPSHOT_SMALL_RESULTS_GAP_MS = '1'; // no minimum gap between post-sync saves in these tests

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
  if (/^SELECT chunk_no/i.test(sql)) return [snap.filter(r => r.table_name === params[0]).sort((a, b) => a.chunk_no - b.chunk_no).map(r => ({ chunk_no: r.chunk_no }))];
  if (/^SELECT payload.*chunk_no = \?/i.test(sql)) return [snap.filter(r => r.table_name === params[0] && r.chunk_no === params[1])];
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
let activeExec = null;
const swapExec = fn => { activeExec = fn; };
const run = (sql, params) => (activeExec || exec)(sql, params);
const poolPath = require.resolve('../src/db/mysqlPool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: { getPool: () => ({ query: run, getConnection: async () => ({
    query: run, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
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

test('after a sync the per-day figures are saved at the next cycle, without waiting for the ten-minute result save', async () => {
  lease = null;
  store._resetForTests();
  await store.restoreSnapshots();
  await store.runCycle({ force: true }); // a full save has just happened
  const saved = t => snap.filter(r => r.table_name === t).reduce((n, r) => n + r.row_count, 0);
  getDb().prepare("INSERT INTO transaction_daily_meta (org_id, journals_known, built_at, definition) VALUES (9001, 1, CURRENT_TIMESTAMP, 2)").run();
  getDb().prepare("INSERT INTO issues (org_id, check_type, importance, count) VALUES (9001, 'y', 'low', 1)").run();
  const issuesBefore = saved('issues');

  await store.runCycle(); // no sync finished: nothing new is saved
  assert.equal(saved('transaction_daily_meta'), 0);

  store.requestResultSave(); // a sync finished
  await new Promise(resolve => setTimeout(resolve, 5));
  await store.runCycle();
  assert.equal(saved('transaction_daily_meta'), 1);
  assert.equal(saved('issues'), issuesBefore); // the large tables keep their ten-minute schedule

  await store.runCycle({ force: true });
  assert.equal(saved('issues'), issuesBefore + 1);
});

test('the small result tables come first in the shutdown save and before the large ones in a full save', () => {
  assert.deepEqual([...store.SMALL_RESULT_TABLES].sort(), ['bank_reconciliation', 'insight_cache', 'period_views', 'transaction_counts', 'transaction_daily', 'transaction_daily_meta']);
  assert.deepEqual(store.LARGE_RESULT_TABLES, ['issues', 'issue_findings']);
  assert.deepEqual([...store.RESULT_TABLES].sort(), [...store.SMALL_RESULT_TABLES, ...store.LARGE_RESULT_TABLES].sort());
  const source = require('fs').readFileSync(require.resolve('../src/db/snapshotStore'), 'utf8');
  const shutdown = source.slice(source.indexOf('const shutdown'));
  assert.ok(shutdown.indexOf('SMALL_RESULT_TABLES') < shutdown.indexOf('REVIEW_TABLES'));
  assert.ok(shutdown.indexOf('REVIEW_TABLES') < shutdown.indexOf('LARGE_RESULT_TABLES'));
});

test('a failed post-sync save is tried again at the next cycle', async () => {
  lease = null;
  store._resetForTests();
  await store.restoreSnapshots();
  await store.runCycle({ force: true });
  getDb().prepare("INSERT INTO transaction_daily_meta (org_id, journals_known, built_at, definition) VALUES (9002, 1, CURRENT_TIMESTAMP, 2)").run();
  const realQuery = exec;
  let failOnce = true;
  const failing = async (sql, params) => {
    if (failOnce && /^INSERT INTO akrio_sqlite_snapshot/i.test(sql) && params[0] === 'transaction_daily_meta') { failOnce = false; throw new Error('MySQL went away'); }
    return realQuery(sql, params);
  };
  swapExec(failing);
  store.requestResultSave();
  await new Promise(resolve => setTimeout(resolve, 5));
  await store.runCycle();
  const saved = () => snap.filter(r => r.table_name === 'transaction_daily_meta').reduce((n, r) => n + r.row_count, 0);
  assert.equal(failOnce, false);
  await new Promise(resolve => setTimeout(resolve, 5));
  await store.runCycle(); // no new sync, but the failed save is retried
  assert.ok(saved() >= 2, 'the retried save includes the new row');
  swapExec(realQuery);
});

// issues and issue_findings are saved at different moments (issue_findings is far larger), so a restart can restore
// findings whose issue the restored issues copy does not have: either a replaced issue, or (the usual case, as
// issues is saved first) an issue a later copy of issues will bring in. They are kept for the second case; the next
// new issue must never be given their id, so it cannot inherit them.
test('a saved finding whose issue is not in the restored issues is kept, and its id is never handed out again', async () => {
  lease = null;
  store._resetForTests();
  const db = getDb();
  db.prepare('DELETE FROM issue_findings').run();
  db.prepare('DELETE FROM issues').run();
  const addIssue = id => db.prepare("INSERT INTO issues (id, org_id, check_type, importance, count, run_id, is_active) VALUES (?, 7001, 'old_unpaid_invoices', 'medium', 1, 11, 1)").run(id);
  const addFinding = (issueId, key) => db.prepare("INSERT INTO issue_findings (issue_id, org_id, check_type, finding_key, detail_json, run_id, is_active) VALUES (?, 7001, 'old_unpaid_invoices', ?, '{}', 11, 1)").run(issueId, key);
  addIssue(500); addFinding(500, 'made-up-a');
  addIssue(501); addFinding(501, 'made-up-stale');
  await store.saveTable('issue_findings'); // the older findings copy still names issue 501
  db.prepare('DELETE FROM issues WHERE id = 501').run(); // a later sync replaced that issue
  await store.saveTable('issues');

  // A fresh container: empty tables and no id counter.
  db.prepare('DELETE FROM issue_findings').run();
  db.prepare('DELETE FROM issues').run();
  db.prepare("DELETE FROM sqlite_sequence WHERE name = 'issues'").run();
  store._resetForTests();
  await store.restoreSnapshots();

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM issue_findings WHERE issue_id = 501').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM issue_findings WHERE issue_id = 500').get().n, 1);
  const fresh = db.prepare("INSERT INTO issues (org_id, check_type, importance, count) VALUES (7001, 'old_unpaid_invoices', 'medium', 1)").run().lastInsertRowid;
  assert.ok(fresh > 501, `new issue id ${fresh} must be past every id a saved finding used`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM issue_findings WHERE issue_id = ?').get(fresh).n, 0);
});

// The usual order: issues is saved first, issue_findings minutes later, so the findings copy can name an issue the
// issues copy does not have yet. When a later copy of issues brings that issue in, its findings must still be there.
test('findings saved before their issue reached the saved issues are still there when the issue arrives', async () => {
  lease = null;
  store._resetForTests();
  const db = getDb();
  db.prepare('DELETE FROM issue_findings').run();
  db.prepare('DELETE FROM issues').run();
  const addIssue = id => db.prepare("INSERT INTO issues (id, org_id, check_type, importance, count, run_id, is_active) VALUES (?, 7002, 'old_unpaid_bills', 'medium', 1, 12, 1)").run(id);
  const addFinding = (issueId, key) => db.prepare("INSERT INTO issue_findings (issue_id, org_id, check_type, finding_key, detail_json, run_id, is_active) VALUES (?, 7002, 'old_unpaid_bills', ?, '{}', 12, 1)").run(issueId, key);
  addIssue(600); addFinding(600, 'made-up-a');
  await store.saveTable('issues'); // issues saved first: no 601 yet
  addIssue(601); addFinding(601, 'made-up-new');
  await store.saveTable('issue_findings'); // findings saved later: names 601

  db.prepare('DELETE FROM issue_findings').run();
  db.prepare('DELETE FROM issues').run();
  db.prepare("DELETE FROM sqlite_sequence WHERE name = 'issues'").run();
  store._resetForTests();
  await store.restoreSnapshots();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM issue_findings WHERE issue_id = 601').get().n, 1);
  addIssue(601); // the next copy of issues brings it in
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM issue_findings f JOIN issues i ON i.id = f.issue_id WHERE f.issue_id = 601').get().n, 1);
});

// Findings of issues that no longer exist are removed by the leader, but only below the highest issue id: a finding
// above it may belong to an issue a newer copy of issues has not brought in yet.
test('dead findings below the highest issue id are removed; live ones and ones above it are kept', async () => {
  const db = getDb();
  db.prepare('DELETE FROM issue_findings').run();
  db.prepare('DELETE FROM issues').run();
  const addIssue = id => db.prepare("INSERT INTO issues (id, org_id, check_type, importance, count, run_id, is_active) VALUES (?, 7003, 'old_unpaid_bills', 'medium', 1, 13, 1)").run(id);
  const addFinding = (issueId, key) => db.prepare("INSERT INTO issue_findings (issue_id, org_id, check_type, finding_key, detail_json, run_id, is_active) VALUES (?, 7003, 'old_unpaid_bills', ?, '{}', 13, 1)").run(issueId, key);
  addFinding(700, 'made-up-dead-1'); addFinding(700, 'made-up-dead-2'); addFinding(702, 'made-up-dead-3'); // issues gone
  addIssue(701); addFinding(701, 'made-up-live');
  addIssue(703); addFinding(703, 'made-up-live-2');
  addFinding(705, 'made-up-not-arrived'); // above the highest issue id: kept
  const removed = await store.pruneOrphanFindings(db);
  assert.equal(removed, 3);
  const left = db.prepare('SELECT issue_id FROM issue_findings ORDER BY issue_id').pluck().all();
  assert.deepEqual(left, [701, 703, 705]);
});
