const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-review-state-${process.pid}-${Date.now()}.db`
);

const { getDb } = require('../src/db/schema');
const {
  deleteIssuesForOrg,
  getIssueByCheckType,
  getIssueFindingSummary,
  getIssueFindings,
  insertIssue,
  refreshLatestHealthScore,
  setFindingReviewStates,
  upsertHealthScore,
} = require('../src/db/queries');
const { isReviewStateActive } = require('../src/services/checkRules');

const db = getDb();
const orgId = Number(db.prepare(`
  INSERT INTO organisations (xero_tenant_id, name) VALUES ('review-test', 'Review Test')
`).run().lastInsertRowid);
upsertHealthScore(orgId, {
  score: 100,
  total_issues: 0,
  total_potential_errors_gbp: 0,
  last_bank_reconciled: null,
  most_recent_transaction: null,
  unreconciled_bank_items: 0,
  lock_date: null,
});

function seed(period = 'period-1') {
  insertIssue({
    org_id: orgId,
    check_type: 'duplicate_invoices',
    importance: 'high',
    count: 2,
    potential_value_gbp: 150,
    detail_json: JSON.stringify([
      { id1: 'invoice-a', id2: 'invoice-b', amount: 100 },
      { id1: 'invoice-c', id2: 'invoice-d', amount: 50 },
      { id1: 'display-a', id2: 'display-b', amount: 999, displayOnly: true },
    ]),
    period_checked: period,
  });
  return getIssueByCheckType(orgId, 'duplicate_invoices');
}

test('review state expiry and period matching are explicit', () => {
  assert.equal(isReviewStateActive(
    { state: 'ignored', ignored_until: '2026-02-01T00:00:00.000Z' },
    'period-1',
    new Date('2026-01-01T00:00:00.000Z')
  ), true);
  assert.equal(isReviewStateActive(
    { state: 'ignored', ignored_until: '2026-01-01T00:00:00.000Z' },
    'period-1',
    new Date('2026-01-02T00:00:00.000Z')
  ), false);
  assert.equal(isReviewStateActive({ state: 'ok', period_key: 'period-1' }, 'period-1'), true);
  assert.equal(isReviewStateActive({ state: 'ok', period_key: 'period-1' }, 'period-2'), false);
});

test('filtering changes count and value while display-only findings never count', () => {
  const issue = seed();
  refreshLatestHealthScore(orgId);
  const scoreBeforeReview = db.prepare(`SELECT score FROM health_scores WHERE org_id = ? ORDER BY id DESC`).get(orgId).score;
  assert.equal(issue.count, 2);
  assert.equal(issue.potential_value_gbp, 150);
  const all = getIssueFindings(issue.id, 1, 50, 'all');
  assert.equal(all.total, 3);

  const firstKey = all.items.find(item => item.amount === 100).finding_key;
  setFindingReviewStates(orgId, 'duplicate_invoices', [firstKey], 'dismissed', 'known pair');
  const reviewed = getIssueByCheckType(orgId, 'duplicate_invoices');
  assert.equal(reviewed.count, 1);
  assert.equal(reviewed.potential_value_gbp, 50);
  assert.equal(getIssueFindings(issue.id, 1, 50, 'dismissed').total, 1);
  assert.equal(getIssueFindings(issue.id, 1, 50, 'active').total, 2);
  const health = db.prepare(`
    SELECT score, score_breakdown_json FROM health_scores WHERE org_id = ? ORDER BY id DESC
  `).get(orgId);
  assert.ok(health.score > scoreBeforeReview);
  const breakdown = JSON.parse(health.score_breakdown_json);
  assert.equal(breakdown.observations.find(row => row.checkType === 'duplicate_invoices').count, 1);
  assert.deepEqual(getIssueFindingSummary(issue.id), {
    active: 2, dismissed: 1, ignored: 0, ok: 0,
  });
});

test('period OK resurfaces in a different period and review survives sync replacement', () => {
  let issue = getIssueByCheckType(orgId, 'duplicate_invoices');
  const secondKey = getIssueFindings(issue.id, 1, 50, 'active').items
    .find(item => !item.displayOnly).finding_key;
  setFindingReviewStates(orgId, 'duplicate_invoices', [secondKey], 'ok');
  assert.equal(getIssueFindings(issue.id, 1, 50, 'ok').total, 1);

  deleteIssuesForOrg(orgId);
  issue = seed('period-2');
  assert.equal(getIssueFindings(issue.id, 1, 50, 'ok').total, 0);
  assert.equal(getIssueFindings(issue.id, 1, 50, 'dismissed').total, 1);
  assert.equal(issue.count, 1);

  const auditCount = db.prepare(`
    SELECT COUNT(*) AS count FROM finding_review_audit WHERE org_id = ?
  `).get(orgId).count;
  assert.ok(auditCount >= 2);
});

test('expired ignore automatically returns to active filtering and aggregates', () => {
  const issue = getIssueByCheckType(orgId, 'duplicate_invoices');
  const key = getIssueFindings(issue.id, 1, 50, 'active').items
    .find(item => !item.displayOnly).finding_key;
  setFindingReviewStates(orgId, 'duplicate_invoices', [key], 'ignored');
  assert.equal(getIssueFindings(issue.id, 1, 50, 'ignored').total, 1);

  db.prepare(`
    UPDATE finding_review_states SET ignored_until = datetime('now', '-1 day')
    WHERE org_id = ? AND check_type = ? AND finding_key = ?
  `).run(orgId, 'duplicate_invoices', key);
  assert.equal(getIssueFindings(issue.id, 1, 50, 'ignored').total, 0);
  assert.equal(getIssueByCheckType(orgId, 'duplicate_invoices').count, 1);
});
