// SKIPPED as of the organisations/xero_tokens/sync_runs/sync_jobs/health_scores -> MySQL
// migration (see src/db/queries.js, src/db/mysqlPool.js, src/services/syncJobs.js).
//
// This file used to point XERO_DASHBOARD_DB_PATH at a disposable SQLite file per run, so it was
// safe to create fixtures directly. It exercises: organisations (mergeEntityCache keys off org_id from an org row)
// — these now write to the SHARED MySQL database, so running this file as it was would either
// throw (AKRIO_DB_USER/PASSWORD unset) or, worse, insert/mutate real rows in that shared database
// if those credentials happen to be present in the environment running tests.
//
// TODO: rewrite against either a disposable MySQL test schema or a mocked pool before
// re-enabling. Left here (rather than deleted) so the original test intent isn't lost — see
// git history for the previous SQLite-based version. Original file header, for context:
// Phase 5, section 1: full-refresh deletion vs incremental-refresh retention, and renamed/voided/
// deleted/merged entity handling. mergeEntityCache (queries.js) is the single write path for every
// cached Xero entity type — this proves its two documented modes live, plus the upsert behaviour
// that renamed/voided/merged entities all rely on (Xero represents rename/void/merge as an updated
// row with the same ID and a bumped UpdatedDateUTC, not a special event type).
//
// Note: getCachedEntities returns the parsed Xero-shaped JSON payloads (contactID/invoiceID etc.),
// not raw DB rows — there is no `entity_id` field on what it returns, only the entity's own ID field.
const test = require('node:test');

test('entityCacheLifecycle.test.js is skipped pending a MySQL-safe rewrite', { skip: 'unsafe to run against the shared MySQL database as written — see file header' }, () => {});
