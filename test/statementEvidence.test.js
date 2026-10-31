// SKIPPED as of the organisations/xero_tokens/sync_runs/sync_jobs/health_scores -> MySQL
// migration (see src/db/queries.js, src/db/mysqlPool.js, src/services/syncJobs.js).
//
// This file used to point XERO_DASHBOARD_DB_PATH at a disposable SQLite file per run, so it was
// safe to create fixtures directly. It exercises: organisations (getOrganisationById), refreshLatestHealthScore (health_scores)
// — these now write to the SHARED MySQL database, so running this file as it was would either
// throw (AKRIO_DB_USER/PASSWORD unset) or, worse, insert/mutate real rows in that shared database
// if those credentials happen to be present in the environment running tests.
//
// TODO: rewrite against either a disposable MySQL test schema or a mocked pool before
// re-enabling. Left here (rather than deleted) so the original test intent isn't lost — see
// git history for the previous SQLite-based version. Original file header, for context:
// (no original header comment)
const test = require('node:test');
const assert = require('node:assert/strict');

test('statementEvidence.test.js is skipped pending a MySQL-safe rewrite', { skip: 'unsafe to run against the shared MySQL database as written — see file header' }, () => {});

test('eligibleFiledAccounts drops older filings with confirmed no bookkeeping but keeps the newest one strict', () => {
  const { eligibleFiledAccounts } = require('../src/services/statementEvidence');
  const synced = '2026-10-31 02:00:00';
  const rows = [
    { filing_date: '2025-05-31', xero_net_assets: -4346.36, xero_synced_at: synced },
    { filing_date: '2024-05-31', xero_net_assets: -6511, xero_synced_at: synced },
    { filing_date: '2023-05-31', xero_net_assets: null, xero_synced_at: synced },   // predates Xero: skip
    { filing_date: '2022-05-31', xero_net_assets: null, xero_synced_at: null },     // not synced yet: keep (needs_sync)
  ];
  assert.deepEqual(eligibleFiledAccounts(rows).map(r => r.filing_date), ['2025-05-31', '2024-05-31', '2022-05-31']);
  // newest filing with no bookkeeping stays: that is a genuine "cannot compare", as before
  const newestEmpty = [
    { filing_date: '2025-05-31', xero_net_assets: null, xero_synced_at: synced },
    { filing_date: '2024-05-31', xero_net_assets: 10, xero_synced_at: synced },
  ];
  assert.deepEqual(eligibleFiledAccounts(newestEmpty).map(r => r.filing_date), ['2025-05-31', '2024-05-31']);
  assert.deepEqual(eligibleFiledAccounts([]), []);
});
