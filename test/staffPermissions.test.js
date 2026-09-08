const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isStaffManager, canAssignRole, canManageAccountAtRole, canAccessSettings, assignableRoles,
} = require('../src/services/staffPermissions');

test('isStaffManager: only admin and super_admin count', () => {
  assert.equal(isStaffManager('super_admin'), true);
  assert.equal(isStaffManager('admin'), true);
  assert.equal(isStaffManager('staff'), false);
  assert.equal(isStaffManager(undefined), false);
});

test('canAssignRole: only super_admin may grant/change admin or super_admin', () => {
  assert.equal(canAssignRole('super_admin', 'staff'), true);
  assert.equal(canAssignRole('super_admin', 'admin'), true);
  assert.equal(canAssignRole('super_admin', 'super_admin'), true);
  assert.equal(canAssignRole('admin', 'staff'), true);
  assert.equal(canAssignRole('admin', 'admin'), false, 'a regular admin cannot promote to admin');
  assert.equal(canAssignRole('admin', 'super_admin'), false);
  assert.equal(canAssignRole('staff', 'staff'), false, 'staff cannot assign any role');
});

test('canManageAccountAtRole: admin can only manage staff-tier accounts, super_admin can manage anyone', () => {
  assert.equal(canManageAccountAtRole('admin', 'staff'), true);
  assert.equal(canManageAccountAtRole('admin', 'admin'), false, 'admin cannot deactivate another admin');
  assert.equal(canManageAccountAtRole('admin', 'super_admin'), false);
  assert.equal(canManageAccountAtRole('super_admin', 'staff'), true);
  assert.equal(canManageAccountAtRole('super_admin', 'admin'), true);
  assert.equal(canManageAccountAtRole('super_admin', 'super_admin'), true);
  assert.equal(canManageAccountAtRole('staff', 'staff'), false);
});

test('canAccessSettings: admins/super_admins always have it; staff only with the explicit grant', () => {
  assert.equal(canAccessSettings({ role: 'super_admin', can_manage_settings: 0 }), true);
  assert.equal(canAccessSettings({ role: 'admin', can_manage_settings: 0 }), true);
  assert.equal(canAccessSettings({ role: 'staff', can_manage_settings: 0 }), false);
  assert.equal(canAccessSettings({ role: 'staff', can_manage_settings: 1 }), true);
  assert.equal(canAccessSettings(null), false);
});

test('assignableRoles: matches what each tier is allowed to hand out', () => {
  assert.deepEqual(assignableRoles('super_admin'), ['staff', 'admin', 'super_admin']);
  assert.deepEqual(assignableRoles('admin'), ['staff']);
  assert.deepEqual(assignableRoles('staff'), []);
});
