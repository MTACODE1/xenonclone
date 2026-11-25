// A new issue must only ever show the findings it was inserted with. After a restart the restored issues and
// issue_findings can come from different moments, so a finding row from an earlier run can already carry the id the
// new issue is given. Made-up data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akrio-issue-id-reuse-'));
process.env.XERO_DASHBOARD_DB_PATH = path.join(dir, 'test.db');
const poolPath = require.resolve('../src/db/mysqlPool');
const fakePool = { query: async () => [[], []], getConnection: async () => ({ query: async () => [[], []], beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} }) };
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => fakePool } };

const queries = require('../src/db/queries');
const { getDb } = require('../src/db/schema');
const { addFindingKeys } = require('../src/services/checkRules');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const ORG = 8801;
const PERIOD = 'since_lock_date:2025-04-30:2026-11-21';
const finding = n => ({ invoiceId: 'inv-' + n, number: 'INV-' + n, date: '2026-10-0' + n, amount: 10 * n, contact: 'Contact ' + n });
const issue = (findings, runId) => ({
  org_id: ORG, check_type: 'old_unpaid_invoices', importance: 'medium', count: findings.length,
  potential_value_gbp: findings.reduce((sum, f) => sum + f.amount, 0), detail_json: JSON.stringify(findings),
  period_checked: PERIOD, run_id: runId, is_active: 1,
});
// Plants a finding from an earlier run on the id the next issue will be given (what a mismatched restore leaves).
function plantStaleFinding(detail, runId) {
  const db = getDb();
  const next = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'issues'").pluck().get() || 0) + 1;
  const [keyed] = addFindingKeys('old_unpaid_invoices', [detail]);
  db.prepare(`INSERT INTO issue_findings (issue_id, org_id, check_type, finding_key, detail_json, potential_value_gbp, run_id, is_active)
    VALUES (?, ?, 'old_unpaid_invoices', ?, ?, ?, ?, 1)`)
    .run(next, ORG, keyed.finding_key, JSON.stringify({ ...detail, stale: true }), detail.amount, runId);
  return next;
}

test('a new issue does not adopt a finding left on its id by an earlier run', () => {
  getDb();
  queries.insertIssue(issue([finding(1)], 100)); // make sure the counter exists
  const reused = plantStaleFinding(finding(2), 90);
  const result = queries.insertIssue(issue([finding(3)], 101));
  assert.equal(Number(result.lastInsertRowid), reused);
  const page = queries.getIssueFindings(reused, ORG, 1, 50, 'all');
  assert.equal(page.items.length, 1, 'only the finding this run produced');
  assert.equal(page.items[0].invoiceId, 'inv-3');
});

test('when the stale finding has the same key, the new run\'s finding wins', () => {
  const reused = plantStaleFinding(finding(4), 91);
  queries.insertIssue(issue([finding(4)], 102));
  const rows = getDb().prepare('SELECT detail_json, run_id FROM issue_findings WHERE issue_id = ?').all(reused);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run_id, 102);
  assert.equal(JSON.parse(rows[0].detail_json).stale, undefined);
});
