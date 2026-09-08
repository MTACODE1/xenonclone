// "Ignore this contact" — a PERMANENT exclusion (contact_exclusions), applied inside insertIssue
// before persisting, so it takes effect on every future sync with no per-check code changes. The
// critical correctness property: excluding a contact must remove exactly that contact's OWN share
// of the total value, never inflate the remaining findings to compensate (a naive "filter then
// re-run allocateFindingValues on the smaller set" implementation would do exactly that, since
// allocateFindingValues scales candidates to sum to whatever total it's given).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-contact-exclusions-${process.pid}-${Date.now()}.db`
);

const { getDb } = require('../src/db/schema');
const {
  upsertOrganisation, getOrganisationByTenantId, insertIssue, getIssueByCheckType,
  addContactExclusion, getContactExclusions, removeContactExclusion, getIssueFindings,
  deleteIssuesForOrg,
} = require('../src/db/queries');

const db = getDb();
upsertOrganisation({ xero_tenant_id: 'contact-excl-org', name: 'Contact Exclusions Org', client_ref: null, tag: null, connection_status: 'connected', last_synced_at: null });
const org = getOrganisationByTenantId('contact-excl-org');

// insertIssue alone (without the real sync's staged-run + activateSyncRun dance) doesn't deactivate
// a prior active issue row for the same check_type — deleteIssuesForOrg cleans the slate so each
// seed() call in these tests behaves like a genuine fresh sync, not a duplicate active row.
function seed() {
  deleteIssuesForOrg(org.id);
  insertIssue({
    org_id: org.id, check_type: 'misallocated_items', importance: 'medium',
    count: 3, potential_value_gbp: 600,
    detail_json: JSON.stringify([
      { invoiceId: 'inv-1', contact: 'Acme Ltd', amount: 100 },
      { invoiceId: 'inv-2', contact: 'Beta Ltd', amount: 200 },
      { invoiceId: 'inv-3', contact: 'Acme Ltd', amount: 300 },
    ]),
    period_checked: 'test-period',
  });
}
seed();

test('before any exclusion, all 3 findings and the full £600 are present', () => {
  const issue = getIssueByCheckType(org.id, 'misallocated_items');
  assert.equal(issue.count, 3);
  assert.equal(issue.potential_value_gbp, 600);
});

test('excluding "Acme Ltd" removes exactly its own £400 share, not a proportional re-inflation of Beta\'s £200', () => {
  addContactExclusion(org.id, 'misallocated_items', 'Acme Ltd');
  // Re-run the sync (insertIssue is what a real sync calls) with the SAME raw data — the exclusion
  // must apply at persist time, not just hide rows after the fact.
  seed();
  const issue = getIssueByCheckType(org.id, 'misallocated_items');
  assert.equal(issue.count, 1, 'only Beta Ltd\'s finding should remain');
  assert.equal(issue.potential_value_gbp, 200, 'must be exactly Beta\'s own £200, not £600 re-inflated onto 1 item');

  const findings = getIssueFindings(issue.id, org.id, 1, 50, 'all').items;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].contact, 'Beta Ltd');
});

test('exclusion matching is case- and whitespace-insensitive', () => {
  addContactExclusion(org.id, 'misallocated_items', '  BETA   ltd  ');
  seed();
  const issue = getIssueByCheckType(org.id, 'misallocated_items');
  assert.equal(issue.count, 0, 'Beta Ltd must now also be excluded despite different casing/whitespace');
  assert.equal(issue.potential_value_gbp, 0);
});

test('adding an exclusion does not retroactively change the currently active issue — it takes effect on the next sync, like every other check-config change', () => {
  // Fresh check type so this test is independent of the exclusions already added above.
  insertIssue({
    org_id: org.id, check_type: 'purchase_tax_missing', importance: 'medium',
    count: 2, potential_value_gbp: 150,
    detail_json: JSON.stringify([
      { invoiceId: 'inv-10', contact: 'Gamma Ltd', amount: 50 },
      { invoiceId: 'inv-11', contact: 'Delta Ltd', amount: 100 },
    ]),
    period_checked: 'test-period',
  });
  const before = getIssueByCheckType(org.id, 'purchase_tax_missing');
  assert.equal(before.count, 2);

  addContactExclusion(org.id, 'purchase_tax_missing', 'Gamma Ltd');
  assert.deepEqual(getIssueByCheckType(org.id, 'purchase_tax_missing'), before,
    'the already-persisted issue must be completely unchanged immediately after adding the exclusion');

  // Only a subsequent sync/reanalyse (another insertIssue call) applies it.
  deleteIssuesForOrg(org.id);
  insertIssue({
    org_id: org.id, check_type: 'purchase_tax_missing', importance: 'medium',
    count: 2, potential_value_gbp: 150,
    detail_json: JSON.stringify([
      { invoiceId: 'inv-10', contact: 'Gamma Ltd', amount: 50 },
      { invoiceId: 'inv-11', contact: 'Delta Ltd', amount: 100 },
    ]),
    period_checked: 'test-period',
  });
  assert.equal(getIssueByCheckType(org.id, 'purchase_tax_missing').count, 1, 'the exclusion applies once a real sync runs');
});

test('exclusions are listed and can be removed, restoring the contact on the next sync', () => {
  const list = getContactExclusions(org.id, 'misallocated_items');
  const keys = list.map(row => row.contact_key);
  assert.ok(keys.includes('acme ltd'));
  assert.ok(keys.includes('beta ltd'));

  removeContactExclusion(org.id, 'misallocated_items', 'Acme Ltd');
  seed();
  const issue = getIssueByCheckType(org.id, 'misallocated_items');
  assert.equal(issue.count, 2, 'Acme Ltd\'s 2 findings must reappear once its exclusion is removed');
  assert.equal(issue.potential_value_gbp, 400);
});

test('addContactExclusion requires every field', () => {
  assert.throws(() => addContactExclusion(org.id, 'misallocated_items', ''), /Missing required field/);
  assert.throws(() => addContactExclusion(org.id, null, 'Acme Ltd'), /Missing required field/);
});
