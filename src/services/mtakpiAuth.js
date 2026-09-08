const mysql = require('mysql2/promise');
const { checkPasswordHash } = require('./werkzeugPassword');

// Read-only connection to MTAKPI's real staff directory (UserDataMatch), so staff log into
// Akrio Verify with the same credentials they already use across the practice's other internal
// tools rather than a second password to manage. This pool must only ever run SELECTs — the DB
// user it connects as should be a dedicated, SELECT-only grant on this table (never the practice's
// main write-capable app credentials), so a compromise of this app can't touch live business data.
let pool = null;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MTAKPI_DB_HOST,
      port: process.env.MTAKPI_DB_PORT || 3306,
      user: process.env.MTAKPI_DB_USER,
      password: process.env.MTAKPI_DB_PASSWORD,
      database: process.env.MTAKPI_DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return pool;
}

// Mirrors MTAKPI's own _resolve_user_data_match_for_login: multiple rows can share a staff_name
// (UK/UAE copies, legacy duplicates) — prefer an enabled one so a disabled duplicate doesn't
// block login for the active record. Extracted as a pure function so this selection rule is
// unit-testable without a real database connection (see mtakpiAuth.test.js).
function resolvePreferredStaffRow(rows) {
  if (!rows.length) return null;
  const enabled = rows.find(row => !row.disabled);
  return enabled || rows[0];
}

// Case-insensitive/trimmed match on staff_name, same as MTAKPI's own login resolution.
async function findMtakpiStaffByName(staffName) {
  const name = String(staffName || '').trim();
  if (!name) return null;
  const [rows] = await getPool().query(
    `SELECT id, staff_name, password_hash, is_admin, team, disabled
     FROM user_data_match
     WHERE LOWER(TRIM(staff_name)) = LOWER(?)
     ORDER BY disabled ASC, id ASC`,
    [name]
  );
  return resolvePreferredStaffRow(rows);
}

// Returns { ok: true, mtakpiStaff } on success, or { ok: false, reason } — 'not_found',
// 'disabled', or 'bad_password' — so the login route can log/message appropriately without the
// caller needing to know MTAKPI's internal shape.
async function verifyMtakpiLogin(staffName, password) {
  const staff = await findMtakpiStaffByName(staffName);
  if (!staff) return { ok: false, reason: 'not_found' };
  if (staff.disabled) return { ok: false, reason: 'disabled' };
  if (!checkPasswordHash(staff.password_hash, password || '')) {
    return { ok: false, reason: 'bad_password' };
  }
  return { ok: true, mtakpiStaff: staff };
}

// Distinct, enabled staff names for the "Add Staff Member" picker — so an admin can see who's
// actually in MTAKPI rather than typing a name from memory. Duplicates (UK/UAE copies etc.)
// collapse to one entry per name since findMtakpiStaffByName treats them as the same login
// identity anyway.
async function listMtakpiStaffNames() {
  const [rows] = await getPool().query(
    `SELECT DISTINCT staff_name FROM user_data_match WHERE disabled = 0 ORDER BY staff_name`
  );
  return rows.map(row => row.staff_name);
}

module.exports = {
  findMtakpiStaffByName, verifyMtakpiLogin, getPool, resolvePreferredStaffRow, listMtakpiStaffNames,
};
