// One-off: recreate the staff roster in whatever database XERO_DASHBOARD_DB_PATH points at.
//
// Production only ever got the single super_admin account bootstrapAdmin() creates on first
// boot (see src/services/bootstrapAdmin.js) — the full 85-person roster was bulk-imported into
// the local dev database at some point and never carried over. This replays that import against
// production using the same data, read from staff-import-data.json (exported from the local DB).
//
// Safe to re-run: createStaffBulk uses INSERT OR IGNORE keyed on the unique mtakpi_staff_name,
// so already-existing accounts (e.g. your own super_admin) are silently skipped, not duplicated.
//
// Run this IN the production environment (wherever XERO_DASHBOARD_DB_PATH / the deploy's working
// directory points at the production data/xero_dashboard.db) — e.g. via an ECS one-off task,
// `railway run node scripts/import-staff.js`, or whatever shell access the deploy provides.
// Running it locally only touches the local dev copy.

const path = require('path');
const fs = require('fs');
const { createStaffBulk } = require('../src/db/queries');

const dataPath = path.join(__dirname, 'staff-import-data.json');
const entries = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

const created = createStaffBulk(entries);
console.log(`Imported ${created} new staff account(s) out of ${entries.length} in the source list.`);
console.log(`(${entries.length - created} were already present and skipped.)`);
