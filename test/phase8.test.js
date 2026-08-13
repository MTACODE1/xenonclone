const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-phase8-${process.pid}-${Date.now()}.db`
);
process.env.SYNC_CONCURRENCY = '1';

const { getDb } = require('../src/db/schema');
const {
  activateSyncRun, createSyncRun, finishSyncRun, getCachedEntities,
  getIssueByCheckType, getOrganisationByTenantId, getTransactionCountsForOrg,
  insertIssue, mergeEntityCache, upsertHealthScore, upsertTransactionCounts,
} = require('../src/db/queries');
const { getJob, startJob } = require('../src/services/syncJobs');

const db = getDb();
const orgId = Number(db.prepare(`
  INSERT INTO organisations (xero_tenant_id, name) VALUES ('phase8', 'Phase Eight Ltd')
`).run().lastInsertRowid);

function issue(runId, count, active = 0) {
  insertIssue({
    org_id: orgId, check_type: 'unapproved_bills', importance: 'medium', count,
    potential_value_gbp: count * 10,
    detail_json: JSON.stringify(Array.from({ length: count }, (_, index) => ({
      id: `bill-${runId}-${index}`, amount: 10,
    }))),
    period_checked: 'current_month:2026-08-01:2026-08-07',
    run_id: runId, is_active: active,
  });
}

function score(runId, value, active = 0) {
  upsertHealthScore(orgId, {
    score: value, total_issues: 1, total_potential_errors_gbp: 10,
    last_bank_reconciled: null, most_recent_transaction: '2026-08-07',
    unreconciled_bank_items: 0, lock_date: '2026-03-31',
    run_id: runId, is_active: active,
  });
}

function counts(runId, turnover) {
  upsertTransactionCounts(orgId, {
    period: 'current_month', period_start: '2026-08-01', period_end: '2026-08-07',
    months_covered: 0.23, turnover, total_transactions: 2,
    customer_invoices: 1, supplier_bills: 1, credit_notes_sales: 0,
    credit_notes_purchase: 0, bank_processed: 0, journals: 0,
    run_id: runId, is_active: 0,
  });
}

test('failed staged run leaves the active verified report untouched', () => {
  const baseline = createSyncRun(orgId, 'full');
  issue(baseline, 1);
  score(baseline, 91);
  counts(baseline, 50);
  activateSyncRun(orgId, baseline);

  const failed = createSyncRun(orgId, 'full');
  issue(failed, 3);
  score(failed, 55);
  finishSyncRun(failed, 'failed', 'simulated fetch failure');

  assert.equal(getIssueByCheckType(orgId, 'unapproved_bills').count, 1);
  assert.equal(getOrganisationByTenantId('phase8').score, 91);
});

test('successful activation atomically swaps issue, score and count snapshots', () => {
  const runId = createSyncRun(orgId, 'full');
  issue(runId, 2);
  score(runId, 82);
  counts(runId, 100);
  activateSyncRun(orgId, runId);

  assert.equal(getIssueByCheckType(orgId, 'unapproved_bills').count, 2);
  assert.equal(getOrganisationByTenantId('phase8').score, 82);
  assert.equal(getTransactionCountsForOrg(orgId, 'current_month').turnover, 100);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM issues WHERE org_id = ? AND is_active = 1
  `).get(orgId).count, 1);
});

test('entity cache merges increments and full refreshes conservatively', () => {
  mergeEntityCache(orgId, 'invoice', [
    { invoiceID: 'a', status: 'AUTHORISED', updatedDateUTC: '2026-08-01T00:00:00Z' },
    { invoiceID: 'b', status: 'DRAFT', updatedDateUTC: '2026-08-01T00:00:00Z' },
  ], { fullRefresh: true });
  mergeEntityCache(orgId, 'invoice', [
    { invoiceID: 'b', status: 'PAID', updatedDateUTC: '2026-08-02T00:00:00Z' },
  ]);
  assert.deepEqual(
    getCachedEntities(orgId, 'invoice').map(item => [item.invoiceID, item.status]),
    [['a', 'AUTHORISED'], ['b', 'PAID']]
  );
  mergeEntityCache(orgId, 'invoice', [
    { invoiceID: 'b', status: 'PAID', updatedDateUTC: '2026-08-02T00:00:00Z' },
  ], { fullRefresh: true });
  assert.deepEqual(getCachedEntities(orgId, 'invoice').map(item => item.invoiceID), ['b']);
});

test('persistent queue deduplicates active work and bounds transient retries', async () => {
  let attempts = 0;
  const runner = async () => {
    attempts++;
    const error = new Error('temporary timeout');
    error.statusCode = 503;
    throw error;
  };
  const first = startJob('phase8:all:queue-test', runner, {
    tenantId: 'phase8', orgId, mode: 'queue-test', maxAttempts: 2,
  });
  const duplicate = startJob('phase8:all:queue-test', runner, {
    tenantId: 'phase8', orgId, mode: 'queue-test', maxAttempts: 2,
  });
  assert.equal(duplicate.existing, true);
  assert.equal(duplicate.job.id, first.job.id);

  const deadline = Date.now() + 6000;
  let job;
  do {
    await new Promise(resolve => setTimeout(resolve, 50));
    job = getJob(first.job.id);
  } while (!['failed', 'succeeded'].includes(job.status) && Date.now() < deadline);

  assert.equal(job.status, 'failed');
  assert.equal(job.attempt, 2);
  assert.equal(attempts, 2);
});

test('all EJS templates compile after stale-warning changes', () => {
  const root = path.join(__dirname, '../src/views');
  const templates = fs.readdirSync(root, { recursive: true })
    .filter(file => file.endsWith('.ejs'));
  assert.ok(templates.length > 0);
  for (const template of templates) {
    assert.doesNotThrow(() => ejs.compile(fs.readFileSync(path.join(root, template), 'utf8'), {
      filename: path.join(root, template),
    }), template);
  }
});
