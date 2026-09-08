// Phase 5, section 1: sync atomicity. activateSyncRun (queries.js) is the exact mechanism that is
// supposed to guarantee "a failed sync leaves the previous active run untouched" and "per-check
// reanalysis damages only the selected check" — this proves it live, at the DB layer, rather than
// re-stating the claim. A full live Xero sync can't be exercised here without network access (see
// apiCallRetry.test.js), but this is the actual transactional boundary that provides the guarantee,
// independent of what upstream Xero calls succeeded or failed before reaching it.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-sync-atomicity-${process.pid}-${Date.now()}.db`
);

const { getDb } = require('../src/db/schema');
const {
  upsertOrganisation, getOrganisationByTenantId, createSyncRun, finishSyncRun, activateSyncRun,
  insertIssue, getIssuesForOrg, upsertHealthScore, upsertTransactionCounts,
  getTransactionCountsForOrg, getOrganisationById,
} = require('../src/db/queries');

const db = getDb();
upsertOrganisation({ xero_tenant_id: 'atomic-org', name: 'Atomicity Test Org', client_ref: null, tag: null, connection_status: 'connected', last_synced_at: null });
const org = getOrganisationByTenantId('atomic-org');

function stageIssue(runId, overrides = {}) {
  const db2 = getDb();
  db2.prepare(`
    INSERT INTO issues (org_id, check_type, importance, count, potential_value_gbp, detail_json,
      period_checked, run_id, is_active)
    VALUES (?, ?, 'high', ?, ?, '[]', 'period', ?, 0)
  `).run(org.id, overrides.check_type || 'duplicate_invoices', overrides.count ?? 1, overrides.value ?? 100, runId);
}

// --- Establish a genuine "previous active run" the same way a real successful sync would. ---
const oldRunId = createSyncRun(org.id, 'full');
stageIssue(oldRunId, { check_type: 'duplicate_invoices', count: 2, value: 500 });
stageIssue(oldRunId, { check_type: 'old_unpaid_invoices', count: 5, value: 1000 });
upsertHealthScore(org.id, {
  score: 87, total_issues: 7, total_potential_errors_gbp: 1500,
  last_bank_reconciled: null, most_recent_transaction: null, unreconciled_bank_items: 0,
  lock_date: null, run_id: oldRunId, is_active: 0,
});
function stageTxCounts(runId) {
  upsertTransactionCounts(org.id, {
    period: 'rolling_12_months', period_start: null, period_end: null, months_covered: 12,
    turnover: 0, total_transactions: 0, customer_invoices: 0, supplier_bills: 0,
    credit_notes_sales: 0, credit_notes_purchase: 0, bank_processed: 0, journals: 0,
    run_id: runId, is_active: 0,
  });
}
stageTxCounts(oldRunId);
activateSyncRun(org.id, oldRunId);

test('the baseline run is genuinely active before any failure is injected', () => {
  const issues = getIssuesForOrg(org.id);
  assert.equal(issues.length, 2);
  assert.equal(db.prepare('SELECT score FROM health_scores WHERE org_id = ? AND is_active = 1').get(org.id).score, 87);
  assert.ok(getTransactionCountsForOrg(org.id, 'rolling_12_months'));
});

test('a sync that fails before staging a health score cannot activate, and the old run is untouched (failure injected at the START)', () => {
  const failedRunId = createSyncRun(org.id, 'full');
  // Simulate a failure immediately after the run row is created — before any check even runs, the
  // real equivalent of an org-info or chart-of-accounts fetch throwing. Nothing is staged at all.
  assert.throws(() => activateSyncRun(org.id, failedRunId), /Cannot activate a run without a staged health score/);
  finishSyncRun(failedRunId, 'failed', 'org info fetch failed');

  const issues = getIssuesForOrg(org.id);
  assert.equal(issues.length, 2, 'the previous run\'s issues must still be the active set');
  assert.equal(issues.find(i => i.check_type === 'duplicate_invoices').count, 2);
  assert.equal(db.prepare('SELECT score FROM health_scores WHERE org_id = ? AND is_active = 1').get(org.id).score, 87);
  assert.equal(db.prepare('SELECT status FROM sync_runs WHERE id = ?').get(failedRunId).status, 'failed');
  assert.equal(db.prepare('SELECT is_active FROM sync_runs WHERE id = ?').get(failedRunId).is_active, 0);
});

test('a sync that stages some issues then fails MID-way (before the health score is staged) leaves the old run fully active', () => {
  const failedRunId = createSyncRun(org.id, 'full');
  // Some checks succeeded and staged their issues (is_active: 0, this run's run_id)...
  stageIssue(failedRunId, { check_type: 'duplicate_invoices', count: 99, value: 99999 });
  stageIssue(failedRunId, { check_type: 'multi_account_suppliers', count: 3, value: 300 });
  // ...but the sync then throws before health_scores/transaction_counts are staged for this run —
  // exactly what happens when a later check (e.g. bank_balance) throws uncaught.
  assert.throws(() => activateSyncRun(org.id, failedRunId), /Cannot activate a run without a staged health score/);
  finishSyncRun(failedRunId, 'failed', 'bank_balance check failed');

  const issues = getIssuesForOrg(org.id);
  assert.equal(issues.length, 2, 'the staged-but-never-activated issues from the failed run must not appear as active');
  assert.equal(issues.find(i => i.check_type === 'duplicate_invoices').count, 2, 'must be the OLD run\'s count, not the failed run\'s 99');
  assert.equal(issues.find(i => i.check_type === 'multi_account_suppliers'), undefined,
    'a check that only exists in the failed run must not leak into the active set');
});

test('a sync that stages a health score but fails before transaction counts still cannot activate (failure injected near the END)', () => {
  const failedRunId = createSyncRun(org.id, 'full');
  stageIssue(failedRunId, { check_type: 'duplicate_invoices', count: 1, value: 1 });
  upsertHealthScore(org.id, {
    score: 42, total_issues: 1, total_potential_errors_gbp: 1,
    last_bank_reconciled: null, most_recent_transaction: null, unreconciled_bank_items: 0,
    lock_date: null, run_id: failedRunId, is_active: 0,
  });
  // Transaction counts never got staged — the sync failed on the very last step.
  assert.throws(() => activateSyncRun(org.id, failedRunId), /Cannot activate a full run without staged transaction counts/);

  assert.equal(db.prepare('SELECT score FROM health_scores WHERE org_id = ? AND is_active = 1').get(org.id).score, 87,
    'the old score must still be active — the new (unactivated) 42 must never surface');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM health_scores WHERE org_id = ? AND run_id = ? AND is_active = 1').get(org.id, failedRunId).c, 0,
    'the failed run\'s staged health score must remain inactive forever, not just momentarily');
});

test('a fully successful new run atomically replaces the old one in a single transaction', () => {
  const newRunId = createSyncRun(org.id, 'full');
  stageIssue(newRunId, { check_type: 'duplicate_invoices', count: 10, value: 2000 });
  upsertHealthScore(org.id, {
    score: 55, total_issues: 10, total_potential_errors_gbp: 2000,
    last_bank_reconciled: null, most_recent_transaction: null, unreconciled_bank_items: 0,
    lock_date: null, run_id: newRunId, is_active: 0,
  });
  stageTxCounts(newRunId);
  activateSyncRun(org.id, newRunId);

  const issues = getIssuesForOrg(org.id);
  assert.equal(issues.length, 1, 'old_unpaid_invoices from the original run must be deactivated — a full sync replaces the whole active set');
  assert.equal(issues[0].check_type, 'duplicate_invoices');
  assert.equal(issues[0].count, 10);
  assert.equal(db.prepare('SELECT score FROM health_scores WHERE org_id = ? AND is_active = 1').get(org.id).score, 55);
  assert.equal(db.prepare('SELECT is_active FROM sync_runs WHERE id = ?').get(oldRunId).is_active, 0, 'the original run is now correctly superseded');
  assert.equal(db.prepare('SELECT status FROM sync_runs WHERE id = ?').get(newRunId).status, 'succeeded');
});

test('a per-check reanalysis (checkType set) only replaces that check, leaving every other active check and the transaction counts untouched', () => {
  // Seed a second, unrelated active check the reanalysis must not touch — a genuine full sync, so
  // this legitimately (and correctly) replaces transaction_counts too; that's not what's under test.
  const seedRunId = createSyncRun(org.id, 'full');
  stageIssue(seedRunId, { check_type: 'duplicate_invoices', count: 4, value: 400 });
  stageIssue(seedRunId, { check_type: 'capital_item_review', count: 2, value: 200 });
  upsertHealthScore(org.id, {
    score: 60, total_issues: 6, total_potential_errors_gbp: 600,
    last_bank_reconciled: null, most_recent_transaction: null, unreconciled_bank_items: 0,
    lock_date: null, run_id: seedRunId, is_active: 0,
  });
  stageTxCounts(seedRunId);
  activateSyncRun(org.id, seedRunId);

  // Snapshot AFTER the seed full-sync settles — this is what a per-check reanalysis must preserve.
  const beforeTxCounts = getTransactionCountsForOrg(org.id, 'rolling_12_months');
  const reanalyseRunId = createSyncRun(org.id, 'check:duplicate_invoices');
  stageIssue(reanalyseRunId, { check_type: 'duplicate_invoices', count: 77, value: 7700 });
  upsertHealthScore(org.id, {
    score: 40, total_issues: 79, total_potential_errors_gbp: 7900,
    last_bank_reconciled: null, most_recent_transaction: null, unreconciled_bank_items: 0,
    lock_date: null, run_id: reanalyseRunId, is_active: 0,
  });
  activateSyncRun(org.id, reanalyseRunId, 'duplicate_invoices');

  const issues = getIssuesForOrg(org.id);
  assert.equal(issues.find(i => i.check_type === 'duplicate_invoices').count, 77, 'the reanalysed check must reflect the new result');
  assert.equal(issues.find(i => i.check_type === 'capital_item_review').count, 2, 'an unrelated active check must survive a single-check reanalysis untouched');
  assert.deepEqual(getTransactionCountsForOrg(org.id, 'rolling_12_months'), beforeTxCounts,
    'transaction counts are full-sync-only data and must not be touched by a per-check reanalysis');
});

test('a failed per-check reanalysis cannot damage the currently active result for that check', () => {
  const before = getIssuesForOrg(org.id).find(i => i.check_type === 'duplicate_invoices');
  const failedReanalysisRunId = createSyncRun(org.id, 'check:duplicate_invoices');
  // The reanalysis staged nothing at all (its own fetch/compute threw before insertIssue ran).
  assert.throws(() => activateSyncRun(org.id, failedReanalysisRunId, 'duplicate_invoices'),
    /Cannot activate a run without a staged health score/);
  finishSyncRun(failedReanalysisRunId, 'failed', 'duplicate_invoices check failed');

  const after = getIssuesForOrg(org.id).find(i => i.check_type === 'duplicate_invoices');
  assert.deepEqual(after, before, 'a failed reanalysis must leave the currently active result completely unchanged');
});
