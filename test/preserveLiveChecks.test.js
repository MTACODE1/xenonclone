// A cache-only recalculation (a custom date range, for example) cannot run the checks that need a live Xero report.
// Before, activating that run deactivated EVERY previous result, so Suspense, Director's Loan and Dividends showed
// "Not synced" (seen on Flyhighdigital and Cinch Technology, 20 Oct 2026). These tests run the SQLite half of run
// activation against an in-memory database, so nothing touches the shared MySQL database or the real SQLite file.
process.env.AKRIO_DB_HOST = process.env.AKRIO_DB_HOST || '127.0.0.1';
process.env.AKRIO_DB_USER = process.env.AKRIO_DB_USER || 'unit-test';
process.env.AKRIO_DB_PASSWORD = process.env.AKRIO_DB_PASSWORD || 'unit-test';
process.env.XERO_DASHBOARD_DB_PATH = process.env.XERO_DASHBOARD_DB_PATH || '/tmp/akrio-unit-test-never-created.db';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { activateSqliteResults, getIssuesForRun, getScoringObservationsForRun } = require('../src/db/queries');
const { LIVE_ONLY_CHECK_TYPES } = require('../src/services/checkRules');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE issues (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER, check_type TEXT, importance TEXT, count INTEGER,
      potential_value_gbp REAL, detail_json TEXT, period_checked TEXT, synced_at TEXT DEFAULT CURRENT_TIMESTAMP, run_id INTEGER, is_active INTEGER);
    CREATE TABLE issue_findings (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER, org_id INTEGER, check_type TEXT, finding_key TEXT,
      detail_json TEXT, display_only INTEGER DEFAULT 0, potential_value_gbp REAL, run_id INTEGER, is_active INTEGER);
    CREATE TABLE transaction_counts (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER, run_id INTEGER, is_active INTEGER);
    CREATE TABLE finding_review_states (org_id INTEGER, check_type TEXT, finding_key TEXT, state TEXT, ignored_until TEXT, period_key TEXT);
  `);
  const issue = (org, type, count, run, active, period = 'since_lock_date:2025-03-31:2026-10-20') => {
    const id = db.prepare(`INSERT INTO issues (org_id, check_type, importance, count, potential_value_gbp, detail_json, period_checked, run_id, is_active)
      VALUES (?, ?, 'critical', ?, ?, NULL, ?, ?, ?)`).run(org, type, count, count * 10, period, run, active).lastInsertRowid;
    for (let i = 0; i < count; i++) {
      db.prepare(`INSERT INTO issue_findings (issue_id, org_id, check_type, finding_key, detail_json, potential_value_gbp, run_id, is_active)
        VALUES (?, ?, ?, ?, '{}', 10, ?, ?)`).run(id, org, type, `${type}-${run}-${i}`, run, active);
    }
  };
  // Run 1: the last live sync, active, for org 1 and for an unrelated org 2.
  issue(1, 'suspense_open_balance', 2, 1, 1);
  issue(1, 'directors_loan_overdrawn', 1, 1, 1);
  issue(1, 'dividend_status', 0, 1, 1);
  issue(1, 'multi_account_suppliers', 5, 1, 1);
  issue(2, 'suspense_open_balance', 3, 1, 1);
  db.prepare('INSERT INTO transaction_counts (org_id, run_id, is_active) VALUES (1, 1, 1), (2, 1, 1)').run();
  // Run 2: a cache-only recalculation for org 1 over a custom period. It could only rerun the stored-data checks.
  issue(1, 'multi_account_suppliers', 7, 2, 0, 'custom:2025-07-31:2026-10-20');
  db.prepare('INSERT INTO transaction_counts (org_id, run_id, is_active) VALUES (1, 2, 0)').run();
  return db;
}
const active = (db, org) => Object.fromEntries(db.prepare(
  'SELECT check_type, count, run_id FROM issues WHERE org_id = ? AND is_active = 1').all(org).map(r => [r.check_type, [r.count, r.run_id]]));

test('live-only checks are exactly Suspense, Director\'s Loan and Dividends', () => {
  assert.deepEqual([...LIVE_ONLY_CHECK_TYPES].sort(), ['directors_loan_overdrawn', 'dividend_status', 'suspense_open_balance']);
});

test('REGRESSION: activating a cache-only run without preserving blanks the live-only checks', () => {
  const db = fixture();
  activateSqliteResults(db, 1, 2, null, []);
  assert.deepEqual(Object.keys(active(db, 1)), ['multi_account_suppliers'], 'this was the bug: three checks disappeared');
});

test('FIX: a cache-only run keeps the last live result of Suspense, Director\'s Loan and Dividends', () => {
  const db = fixture();
  activateSqliteResults(db, 1, 2, null, [...LIVE_ONLY_CHECK_TYPES]);
  assert.deepEqual(active(db, 1), {
    suspense_open_balance: [2, 1], directors_loan_overdrawn: [1, 1], dividend_status: [0, 1],   // kept from run 1
    multi_account_suppliers: [7, 2],                                                              // replaced by run 2
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM issues WHERE org_id = 1 AND check_type = 'multi_account_suppliers' AND is_active = 1").get().n, 1,
    'the recalculated check is never duplicated');
  const findings = db.prepare('SELECT check_type, COUNT(*) AS n FROM issue_findings WHERE org_id = 1 AND is_active = 1 GROUP BY check_type').all();
  assert.deepEqual(Object.fromEntries(findings.map(f => [f.check_type, f.n])),
    { suspense_open_balance: 2, directors_loan_overdrawn: 1, multi_account_suppliers: 7 }, 'item-level findings follow their check');
});

test('FIX: another client is never touched by the recalculation', () => {
  const db = fixture();
  activateSqliteResults(db, 1, 2, null, [...LIVE_ONLY_CHECK_TYPES]);
  assert.deepEqual(active(db, 2), { suspense_open_balance: [3, 1] });
});

test('the health score is calculated with the kept results included', () => {
  const db = fixture();
  const before = getIssuesForRun(1, 2, null, [], db).map(i => i.check_type);
  assert.deepEqual(before, ['multi_account_suppliers'], 'without preserving, the score would ignore three checks');
  const kept = getIssuesForRun(1, 2, null, [...LIVE_ONLY_CHECK_TYPES], db);
  assert.deepEqual(kept.map(i => i.check_type).sort(), ['directors_loan_overdrawn', 'dividend_status', 'multi_account_suppli' + 'ers', 'suspense_open_balance']);
  const observations = getScoringObservationsForRun(1, 2, null, [...LIVE_ONLY_CHECK_TYPES], db);
  const bySuspense = observations.find(o => o.check_type === 'suspense_open_balance');
  assert.equal(bySuspense.findings.length, 2, 'the kept check carries its own findings into the score');
  assert.equal(observations.find(o => o.check_type === 'multi_account_suppliers').findings.length, 7);
});

test('a normal full run and a per-check run behave as before', () => {
  const full = fixture();
  activateSqliteResults(full, 1, 2, null);
  assert.deepEqual(Object.keys(active(full, 1)), ['multi_account_suppliers'], 'full run with nothing to preserve replaces everything');

  const perCheck = fixture();
  perCheck.prepare("UPDATE issues SET run_id = 3 WHERE run_id = 2").run();
  perCheck.prepare("UPDATE issue_findings SET run_id = 3 WHERE run_id = 2").run();
  activateSqliteResults(perCheck, 1, 3, 'multi_account_suppliers', [...LIVE_ONLY_CHECK_TYPES]);
  assert.equal(Object.keys(active(perCheck, 1)).length, 4, 'a per-check run changes only its own check');
});

test('a full run still refuses to activate without staged transaction counts', () => {
  const db = fixture();
  db.prepare('DELETE FROM transaction_counts WHERE run_id = 2').run();
  assert.throws(() => activateSqliteResults(db, 1, 2, null, []), /staged transaction counts/);
});
