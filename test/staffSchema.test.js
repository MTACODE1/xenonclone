// Confirms the staff-login schema additions (staff_users, staff_org_access, sessions) exist and
// are additive — this test doesn't touch any pre-existing table, matching the project's
// "CREATE IF NOT EXISTS + PRAGMA table_info check" migration convention.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-staff-schema-${process.pid}-${Date.now()}.db`
);

const { getDb } = require('../src/db/schema');

const db = getDb();

test('staff_users table exists with expected columns (no password stored — auth happens against MTAKPI)', () => {
  const columns = db.prepare(`PRAGMA table_info(staff_users)`).all().map(c => c.name);
  for (const expected of ['id', 'mtakpi_staff_name', 'name', 'initials', 'role', 'can_manage_settings', 'is_active', 'created_at', 'last_login_at']) {
    assert.ok(columns.includes(expected), `missing column ${expected}`);
  }
  assert.ok(!columns.includes('password_hash'), 'staff_users must not store a password locally');
  assert.ok(!columns.includes('email'), 'staff_users is keyed by mtakpi_staff_name, not email');
});

test('staff_users.role accepts all three tiers: super_admin, admin, staff', () => {
  for (const role of ['super_admin', 'admin', 'staff']) {
    assert.doesNotThrow(() => {
      db.prepare(`INSERT INTO staff_users (mtakpi_staff_name, name, initials, role) VALUES (?, ?, ?, ?)`)
        .run(`Tier Test ${role}`, `Tier Test ${role}`, 'TT', role);
    }, `role ${role} should be accepted`);
  }
});

test('staff_org_access table exists with expected columns', () => {
  const columns = db.prepare(`PRAGMA table_info(staff_org_access)`).all().map(c => c.name);
  assert.deepEqual(columns.sort(), ['granted_at', 'org_id', 'staff_id'].sort());
});

test('sessions table exists with expected columns', () => {
  const columns = db.prepare(`PRAGMA table_info(sessions)`).all().map(c => c.name);
  assert.deepEqual(columns.sort(), ['expires_at', 'session_json', 'sid'].sort());
});

test('staff_users.role rejects values outside admin/staff', () => {
  assert.throws(() => {
    db.prepare(`INSERT INTO staff_users (mtakpi_staff_name, name, initials, role) VALUES (?, ?, ?, ?)`)
      .run('Bad Role Person', 'Bad Role', 'BR', 'superadmin');
  }, /CHECK constraint failed/);
});

test('staff_users.mtakpi_staff_name is unique', () => {
  db.prepare(`INSERT INTO staff_users (mtakpi_staff_name, name, initials, role) VALUES (?, ?, ?, ?)`)
    .run('Jane Doe', 'Jane Doe', 'JD', 'staff');
  assert.throws(() => {
    db.prepare(`INSERT INTO staff_users (mtakpi_staff_name, name, initials, role) VALUES (?, ?, ?, ?)`)
      .run('Jane Doe', 'Jane D. Second', 'JD', 'staff');
  }, /UNIQUE constraint failed/);
});
