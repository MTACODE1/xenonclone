const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-bootstrap-admin-${process.pid}-${Date.now()}.db`
);

const { getDb } = require('../src/db/schema');
const { getAllStaff, getStaffByMtakpiName } = require('../src/db/queries');
const { bootstrapAdmin } = require('../src/services/bootstrapAdmin');

getDb();

test('bootstrapAdmin creates one admin linked to ADMIN_MTAKPI_STAFF_NAME when the staff table is empty', () => {
  process.env.ADMIN_MTAKPI_STAFF_NAME = 'Boot Admin';
  bootstrapAdmin();
  const staff = getStaffByMtakpiName('Boot Admin');
  assert.ok(staff, 'admin account should have been created');
  assert.equal(staff.role, 'super_admin');
  assert.equal(staff.password_hash, undefined, 'no password should ever be stored locally');
});

test('bootstrapAdmin is a no-op once staff already exist, even if called again', () => {
  const before = getAllStaff().length;
  bootstrapAdmin();
  assert.equal(getAllStaff().length, before, 'must not create a second admin');
});

test('bootstrapAdmin skips silently (does not throw) when the env var is unset and staff table is empty', () => {
  process.env.XERO_DASHBOARD_DB_PATH = path.join(
    os.tmpdir(), `xero-bootstrap-admin-empty-${process.pid}-${Date.now()}.db`
  );
  delete require.cache[require.resolve('../src/db/schema')];
  delete require.cache[require.resolve('../src/db/queries')];
  const schema = require('../src/db/schema');
  schema.getDb();
  delete process.env.ADMIN_MTAKPI_STAFF_NAME;
  assert.doesNotThrow(() => bootstrapAdmin());
  const { getAllStaff: getAllStaffFresh } = require('../src/db/queries');
  assert.equal(getAllStaffFresh().length, 0);
});
