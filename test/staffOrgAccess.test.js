// SKIPPED as of the staff/access -> MySQL migration (see src/db/queries.js, src/db/mysqlPool.js).
//
// This file used to point XERO_DASHBOARD_DB_PATH at a disposable SQLite file per run, so it was
// safe to call createStaff/replaceStaffOrgAccess etc. directly at module load time. Those
// functions now write to the SHARED MySQL database (akrio_staff_users / akrio_staff_org_access)
// — running this file as it was would insert real rows ("Scoped Staff", "Org A", "Org B") into
// that shared database the moment it's required, with no isolation from real data.
//
// TODO: rewrite against either a disposable MySQL test schema or a mocked pool before
// re-enabling. Left here (rather than deleted) so the original test intent isn't lost — see
// git history for the previous SQLite-based version.
const test = require('node:test');

test('staffOrgAccess.test.js is skipped pending a MySQL-safe rewrite', { skip: 'unsafe to run against the shared MySQL database as written — see file header' }, () => {});
