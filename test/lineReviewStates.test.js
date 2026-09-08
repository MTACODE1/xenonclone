// Per-transaction "reviewed" audit trail (finding_line_reviews) — a lightweight mark, deliberately
// separate from the contact-level dismiss/ignore/OK system. The key invariant under test: marking
// one transaction line reviewed must never change the parent finding's count/value/score, since
// those are computed per contact, not per transaction.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-line-review-${process.pid}-${Date.now()}.db`
);

const { getDb } = require('../src/db/schema');
const {
  upsertOrganisation, getOrganisationByTenantId, insertIssue, getIssueByCheckType,
  setLineReviewState, getLineReviewStates,
} = require('../src/db/queries');

const db = getDb();
upsertOrganisation({ xero_tenant_id: 'line-review-org', name: 'Line Review Org', client_ref: null, tag: null, connection_status: 'connected', last_synced_at: null });
const org = getOrganisationByTenantId('line-review-org');

insertIssue({
  org_id: org.id, check_type: 'multi_account_suppliers', importance: 'medium',
  count: 1, potential_value_gbp: 110,
  detail_json: JSON.stringify([{
    contactId: 'c-1', name: 'ALIE J M', accountCodes: ['325', '835'], potentialValue: 110,
    transactions: [{ bankTransactionId: 'tx-1', amount: 1500 }, { bankTransactionId: 'tx-2', amount: 110 }],
  }]),
  period_checked: 'test-period',
});
const issue = getIssueByCheckType(org.id, 'multi_account_suppliers');
const findingKey = db.prepare('SELECT finding_key FROM issue_findings WHERE issue_id = ?').get(issue.id).finding_key;

test('a transaction starts unreviewed with no state', () => {
  const states = getLineReviewStates(org.id, 'multi_account_suppliers', findingKey);
  assert.deepEqual(states, {});
});

test('marking a transaction OK persists and is retrievable, without touching the parent finding', () => {
  setLineReviewState(org.id, 'multi_account_suppliers', findingKey, 'tx-1', true, 'Confirmed correct account');
  const states = getLineReviewStates(org.id, 'multi_account_suppliers', findingKey);
  assert.equal(states['tx-1'].ok, true);
  assert.equal(states['tx-1'].notes, 'Confirmed correct account');
  assert.equal(states['tx-2'], undefined, 'an unmarked transaction must have no entry');

  const after = getIssueByCheckType(org.id, 'multi_account_suppliers');
  assert.equal(after.count, 1, 'the parent finding\'s count must be unaffected by a line-level mark');
  assert.equal(after.potential_value_gbp, 110, 'the parent finding\'s value must be unaffected by a line-level mark');
});

test('marking the same transaction again updates in place rather than duplicating', () => {
  setLineReviewState(org.id, 'multi_account_suppliers', findingKey, 'tx-1', false, 'Actually needs re-coding');
  const states = getLineReviewStates(org.id, 'multi_account_suppliers', findingKey);
  assert.equal(states['tx-1'].ok, false);
  assert.equal(states['tx-1'].notes, 'Actually needs re-coding');
  const count = db.prepare('SELECT COUNT(*) c FROM finding_line_reviews WHERE org_id = ? AND line_key = ?').get(org.id, 'tx-1').c;
  assert.equal(count, 1, 'must update the existing row, not insert a second one');
});

test('setLineReviewState requires every field', () => {
  assert.throws(() => setLineReviewState(org.id, 'multi_account_suppliers', findingKey, null, true), /Missing required field/);
  assert.throws(() => setLineReviewState(org.id, null, findingKey, 'tx-3', true), /Missing required field/);
});

test('two organisations with the same line_key (a coincidental Xero id collision) do not see each other\'s marks', () => {
  upsertOrganisation({ xero_tenant_id: 'line-review-org-b', name: 'Line Review Org B', client_ref: null, tag: null, connection_status: 'connected', last_synced_at: null });
  const orgB = getOrganisationByTenantId('line-review-org-b');
  insertIssue({
    org_id: orgB.id, check_type: 'multi_account_suppliers', importance: 'medium',
    count: 1, potential_value_gbp: 110,
    detail_json: JSON.stringify([{
      contactId: 'c-1', name: 'ALIE J M', accountCodes: ['325', '835'], potentialValue: 110,
      transactions: [{ bankTransactionId: 'tx-1', amount: 1500 }],
    }]),
    period_checked: 'test-period',
  });
  const issueB = getIssueByCheckType(orgB.id, 'multi_account_suppliers');
  const findingKeyB = db.prepare('SELECT finding_key FROM issue_findings WHERE issue_id = ?').get(issueB.id).finding_key;

  const statesB = getLineReviewStates(orgB.id, 'multi_account_suppliers', findingKeyB);
  assert.deepEqual(statesB, {}, 'org B must not see org A\'s mark on the same line_key/finding_key');
});
