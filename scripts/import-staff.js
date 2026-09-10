// One-off: import the staff roster into akrio_staff_users (the shared MySQL database).
//
// Production only ever got the single super_admin account bootstrapAdmin() creates on first
// boot (see src/services/bootstrapAdmin.js) — the full 85-person roster was bulk-imported into
// the local dev SQLite copy at some point and never carried over. This replays that import
// using the same data, read from staff-import-data.json (exported from the local DB), now
// against the akrio_staff_users table created by scripts/mysql-schema.sql.
//
// Safe to re-run: createStaffBulk uses INSERT IGNORE keyed on the unique mtakpi_staff_name, so
// already-existing accounts (e.g. your own super_admin) are silently skipped, not duplicated.
//
// Requires AKRIO_DB_USER / AKRIO_DB_PASSWORD (write-capable MySQL credentials) to be set in the
// environment this runs in — see src/db/mysqlPool.js.

const path = require('path');
const fs = require('fs');
const { createStaffBulk } = require('../src/db/queries');

const dataPath = path.join(__dirname, 'staff-import-data.json');
const entries = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

createStaffBulk(entries).then(created => {
  console.log(`Imported ${created} new staff account(s) out of ${entries.length} in the source list.`);
  console.log(`(${entries.length - created} were already present and skipped.)`);
  process.exit(0);
}).catch(error => {
  console.error('Import failed:', error);
  process.exit(1);
});
