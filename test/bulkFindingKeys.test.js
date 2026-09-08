// getAllFindingKeysForIssue backs the "Ignore/Dismiss all N items" bulk buttons — the key
// invariant: it must NOT be capped like getIssueFindings' display pagination (capped at 100),
// since a real check can have thousands of active findings (Rose's purchase_tax_missing: 2952).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-bulk-finding-keys-${process.pid}-${Date.now()}.db`
);

const {
  upsertOrganisation, getOrganisationByTenantId, insertIssue, getIssueByCheckType,
  getAllFindingKeysForIssue, setFindingReviewStates,
} = require('../src/db/queries');

upsertOrganisation({ xero_tenant_id: 'bulk-keys-org', name: 'Bulk Keys Org', client_ref: null, tag: null, connection_status: 'connected', last_synced_at: null });
const org = getOrganisationByTenantId('bulk-keys-org');

// 250 findings — well past getIssueFindings' 100-item pagination cap.
const findings = Array.from({ length: 250 }, (_, i) => ({ id: `doc-${i}`, contact: `Contact ${i}`, amountDue: 10 }));
insertIssue({
  org_id: org.id, check_type: 'old_unpaid_bills', importance: 'high',
  count: 250, potential_value_gbp: 2500,
  detail_json: JSON.stringify(findings),
  period_checked: 'test-period',
});
const issue = getIssueByCheckType(org.id, 'old_unpaid_bills');

test('getAllFindingKeysForIssue returns every active key, not capped at 100', () => {
  const keys = getAllFindingKeysForIssue(issue.id, org.id, 'active');
  assert.equal(keys.length, 250, 'must return all 250, not the 100-item display-pagination cap');
  assert.equal(new Set(keys).size, 250, 'every key must be unique');
});

test('a bulk "ignore all" using these keys reaches every one of the 250 findings', () => {
  const keys = getAllFindingKeysForIssue(issue.id, org.id, 'active');
  const changed = setFindingReviewStates(org.id, 'old_unpaid_bills', keys, 'ignored');
  assert.equal(changed, 250, 'must apply to all 250 findings, not just the first 100');
  assert.equal(getIssueByCheckType(org.id, 'old_unpaid_bills').count, 0, 'all findings are now ignored, so the active count must drop to 0');
});
