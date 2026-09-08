// A note attached to a finding independent of its dismiss/ignore/ok review state (finding_notes) —
// the key invariant: setting a note must never change the parent issue's count/value/score, and
// must persist across restarts/independent of whatever the finding's review state is.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-finding-notes-${process.pid}-${Date.now()}.db`
);

const { getDb } = require('../src/db/schema');
const {
  upsertOrganisation, getOrganisationByTenantId, insertIssue, getIssueByCheckType,
  setFindingNote, getFindingNotes, setFindingReviewStates,
} = require('../src/db/queries');

const db = getDb();
upsertOrganisation({ xero_tenant_id: 'finding-notes-org', name: 'Finding Notes Org', client_ref: null, tag: null, connection_status: 'connected', last_synced_at: null });
const org = getOrganisationByTenantId('finding-notes-org');

insertIssue({
  org_id: org.id, check_type: 'old_unpaid_invoices', importance: 'high',
  count: 2, potential_value_gbp: 250,
  detail_json: JSON.stringify([
    { id: 'inv-1', number: 'INV-001', contact: 'Acme Ltd', amountDue: 100 },
    { id: 'inv-2', number: 'INV-002', contact: 'Beta Ltd', amountDue: 150 },
  ]),
  period_checked: 'test-period',
});
const issue = getIssueByCheckType(org.id, 'old_unpaid_invoices');
const findingKeys = db.prepare('SELECT finding_key FROM issue_findings WHERE issue_id = ? ORDER BY id').all(issue.id).map(r => r.finding_key);

test('a finding starts with no note', () => {
  assert.deepEqual(getFindingNotes(org.id, 'old_unpaid_invoices'), {});
});

test('adding a note does not change the finding\'s review state or the parent issue\'s count/value', () => {
  setFindingNote(org.id, 'old_unpaid_invoices', findingKeys[0], 'Chased customer 10/09 — awaiting payment');
  const notes = getFindingNotes(org.id, 'old_unpaid_invoices');
  assert.equal(notes[findingKeys[0]], 'Chased customer 10/09 — awaiting payment');
  assert.equal(notes[findingKeys[1]], undefined, 'the other finding must have no note');

  const after = getIssueByCheckType(org.id, 'old_unpaid_invoices');
  assert.equal(after.count, 2, 'a note must never change the active count');
  assert.equal(after.potential_value_gbp, 250, 'a note must never change the active value');

  const reviewRow = db.prepare('SELECT * FROM finding_review_states WHERE org_id = ? AND finding_key = ?').get(org.id, findingKeys[0]);
  assert.equal(reviewRow, undefined, 'adding a note must not create a dismiss/ignore/ok review-state row');
});

test('a note survives being dismissed and later restored', () => {
  setFindingReviewStates(org.id, 'old_unpaid_invoices', [findingKeys[0]], 'dismissed');
  assert.equal(getIssueByCheckType(org.id, 'old_unpaid_invoices').count, 1, 'dismissing must reduce the active count');
  let notes = getFindingNotes(org.id, 'old_unpaid_invoices');
  assert.equal(notes[findingKeys[0]], 'Chased customer 10/09 — awaiting payment', 'the note must survive being dismissed');

  setFindingReviewStates(org.id, 'old_unpaid_invoices', [findingKeys[0]], 'restore');
  assert.equal(getIssueByCheckType(org.id, 'old_unpaid_invoices').count, 2);
  notes = getFindingNotes(org.id, 'old_unpaid_invoices');
  assert.equal(notes[findingKeys[0]], 'Chased customer 10/09 — awaiting payment', 'the note must survive being restored');
});

test('setting a note again updates in place rather than duplicating', () => {
  setFindingNote(org.id, 'old_unpaid_invoices', findingKeys[0], 'Updated note');
  const count = db.prepare('SELECT COUNT(*) c FROM finding_notes WHERE org_id = ? AND finding_key = ?').get(org.id, findingKeys[0]).c;
  assert.equal(count, 1, 'must update the existing row, not insert a second one');
  assert.equal(getFindingNotes(org.id, 'old_unpaid_invoices')[findingKeys[0]], 'Updated note');
});

test('setFindingNote requires every field', () => {
  assert.throws(() => setFindingNote(org.id, 'old_unpaid_invoices', null, 'x'), /Missing required field/);
  assert.throws(() => setFindingNote(org.id, null, findingKeys[1], 'x'), /Missing required field/);
});
