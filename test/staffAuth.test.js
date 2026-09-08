// Local staff_users CRUD — the layer src/routes/staffAuth.js's login handler looks up AFTER
// MTAKPI itself has already verified the password (see werkzeugPassword.test.js for the password
// verification logic, and mtakpiAuth.test.js for the MTAKPI lookup logic). No password lives here.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-staff-auth-${process.pid}-${Date.now()}.db`
);

const { getDb } = require('../src/db/schema');
const {
  createStaff, getStaffByMtakpiName, getStaffById, getAllStaff, deactivateStaff, reactivateStaff,
  touchStaffLastLogin,
} = require('../src/db/queries');

getDb();

test('createStaff links a local role/access record to an MTAKPI identity, no password stored', () => {
  const staff = createStaff({
    mtakpi_staff_name: 'Sarah Jones', name: 'Sarah Jones', initials: 'SJ', role: 'staff',
  });
  assert.equal(staff.mtakpi_staff_name, 'Sarah Jones');
  assert.equal(staff.is_active, 1);
  assert.equal(staff.password_hash, undefined);
});

test('getStaffByMtakpiName matches case-insensitively and trimmed, same as MTAKPI\'s own login resolution', () => {
  createStaff({ mtakpi_staff_name: 'Dave Roberts', name: 'Dave Roberts', initials: 'DR', role: 'admin' });
  assert.ok(getStaffByMtakpiName('Dave Roberts'));
  assert.ok(getStaffByMtakpiName('dave roberts'));
  assert.ok(getStaffByMtakpiName('  DAVE ROBERTS  '));
  assert.equal(getStaffByMtakpiName('Someone Else'), undefined);
});

test('mtakpi_staff_name uniqueness is enforced', () => {
  createStaff({ mtakpi_staff_name: 'Amy Adams', name: 'Amy Adams', initials: 'AA', role: 'staff' });
  assert.throws(() => {
    createStaff({ mtakpi_staff_name: 'Amy Adams', name: 'Amy A. Duplicate', initials: 'AD', role: 'staff' });
  }, /UNIQUE constraint failed/);
});

test('deactivateStaff/reactivateStaff toggle is_active without deleting the row', () => {
  const staff = createStaff({ mtakpi_staff_name: 'Toggle Person', name: 'Toggle Person', initials: 'TP', role: 'staff' });
  deactivateStaff(staff.id);
  assert.equal(getStaffById(staff.id).is_active, 0);
  reactivateStaff(staff.id);
  assert.equal(getStaffById(staff.id).is_active, 1);
});

test('touchStaffLastLogin sets last_login_at', () => {
  const staff = createStaff({ mtakpi_staff_name: 'Login Person', name: 'Login Person', initials: 'LP', role: 'staff' });
  assert.equal(staff.last_login_at, null);
  touchStaffLastLogin(staff.id);
  assert.ok(getStaffById(staff.id).last_login_at);
});

test('getAllStaff returns rows ordered by name', () => {
  const names = getAllStaff().map(s => s.name);
  const sorted = [...names].sort();
  assert.deepEqual(names, sorted);
});
