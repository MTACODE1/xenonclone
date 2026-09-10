// SKIPPED as of the organisations/xero_tokens/sync_runs/sync_jobs/health_scores -> MySQL
// migration (see src/db/queries.js, src/db/mysqlPool.js, src/services/syncJobs.js).
//
// This file used to point XERO_DASHBOARD_DB_PATH at a disposable SQLite file per run, so it was
// safe to create fixtures directly. It exercises: organisations
// — these now write to the SHARED MySQL database, so running this file as it was would either
// throw (AKRIO_DB_USER/PASSWORD unset) or, worse, insert/mutate real rows in that shared database
// if those credentials happen to be present in the environment running tests.
//
// TODO: rewrite against either a disposable MySQL test schema or a mocked pool before
// re-enabling. Left here (rather than deleted) so the original test intent isn't lost — see
// git history for the previous SQLite-based version. Original file header, for context:
// A note attached to a finding independent of its dismiss/ignore/ok review state (finding_notes) —
// the key invariant: setting a note must never change the parent issue's count/value/score, and
// must persist across restarts/independent of whatever the finding's review state is.
const test = require('node:test');

test('findingNotes.test.js is skipped pending a MySQL-safe rewrite', { skip: 'unsafe to run against the shared MySQL database as written — see file header' }, () => {});
