// SKIPPED as of the staff/access -> MySQL migration (see src/db/queries.js, src/db/mysqlPool.js).
//
// This file used to point XERO_DASHBOARD_DB_PATH at a disposable SQLite file per run. bootstrapAdmin
// now creates its account via createStaff, which writes to the SHARED MySQL database
// (akrio_staff_users) — running this file as it was would insert a real "Boot Admin" row into
// that shared database, with no isolation.
//
// TODO: rewrite against either a disposable MySQL test schema or a mocked pool before
// re-enabling. Left here (rather than deleted) so the original test intent isn't lost — see
// git history for the previous SQLite-based version.
const test = require('node:test');

test('bootstrapAdmin.test.js is skipped pending a MySQL-safe rewrite', { skip: 'unsafe to run against the shared MySQL database as written — see file header' }, () => {});
