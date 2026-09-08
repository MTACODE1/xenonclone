// staff_org_access join-table behavior — what src/middleware/orgAccess.js and
// src/routes/dashboard.js's per-staff filtering are built on.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-staff-org-access-${process.pid}-${Date.now()}.db`
);

const { getDb } = require('../src/db/schema');
const {
  createStaff, upsertOrganisation, getOrganisationByTenantId,
  staffHasOrgAccess, getOrgIdsForStaff, getStaffForOrg, replaceStaffOrgAccess, toggleStaffOrgAccess,
} = require('../src/db/queries');

getDb();

upsertOrganisation({ xero_tenant_id: 'org-access-a', name: 'Org A', client_ref: null, tag: null, connection_status: 'connected', last_synced_at: null });
upsertOrganisation({ xero_tenant_id: 'org-access-b', name: 'Org B', client_ref: null, tag: null, connection_status: 'connected', last_synced_at: null });
const orgA = getOrganisationByTenantId('org-access-a');
const orgB = getOrganisationByTenantId('org-access-b');
const staff = createStaff({ mtakpi_staff_name: 'Scoped Staff', name: 'Scoped Staff', initials: 'SS', role: 'staff' });

test('a staff member with no grants has access to nothing', () => {
  assert.equal(staffHasOrgAccess(staff.id, orgA.id), false);
  assert.deepEqual(getOrgIdsForStaff(staff.id), []);
});

test('replaceStaffOrgAccess grants exactly the given set — matches this test\'s two-org isolation pattern', () => {
  replaceStaffOrgAccess(staff.id, [orgA.id]);
  assert.equal(staffHasOrgAccess(staff.id, orgA.id), true);
  assert.equal(staffHasOrgAccess(staff.id, orgB.id), false);
  assert.deepEqual(getOrgIdsForStaff(staff.id), [orgA.id]);
});

test('replaceStaffOrgAccess called again fully replaces the previous set, not merges', () => {
  replaceStaffOrgAccess(staff.id, [orgB.id]);
  assert.equal(staffHasOrgAccess(staff.id, orgA.id), false, 'org A grant must be gone after replace');
  assert.equal(staffHasOrgAccess(staff.id, orgB.id), true);
});

test('toggleStaffOrgAccess grants and revokes a single pair without touching others', () => {
  toggleStaffOrgAccess(staff.id, orgA.id, true);
  assert.deepEqual(new Set(getOrgIdsForStaff(staff.id)), new Set([orgA.id, orgB.id]));
  toggleStaffOrgAccess(staff.id, orgB.id, false);
  assert.deepEqual(getOrgIdsForStaff(staff.id), [orgA.id]);
});

test('getStaffForOrg returns only active staff assigned to that org, for avatar badges', () => {
  const forOrgA = getStaffForOrg(orgA.id);
  assert.equal(forOrgA.length, 1);
  assert.equal(forOrgA[0].initials, 'SS');
  assert.equal(getStaffForOrg(orgB.id).length, 0);
});

test('deleting an organisation cascades and removes its access grants (ON DELETE CASCADE)', () => {
  const db = getDb();
  db.prepare(`DELETE FROM organisations WHERE id = ?`).run(orgA.id);
  assert.deepEqual(getOrgIdsForStaff(staff.id), []);
});
