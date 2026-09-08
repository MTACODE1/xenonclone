// Phase 5, section 2: concurrent sync attempts, job cancellation, and failed-job handling.
// startJob's dedup window is real but narrow (it only dedupes while a job is still 'queued' or
// 'running') — a live curl-based probe against a synthetic org whose sync fails in milliseconds
// (no real Xero token) cannot reliably observe it, since the first job finishes before the second
// request's dedup check runs. A controllable runner that only resolves when the test says so proves
// the actual in-flight window deterministically instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-sync-jobs-${process.pid}-${Date.now()}.db`
);

const { getDb } = require('../src/db/schema');
const { upsertOrganisation, getOrganisationByTenantId } = require('../src/db/queries');
const { startJob, getJob, cancelJob } = require('../src/services/syncJobs');

const db = getDb();
upsertOrganisation({ xero_tenant_id: 'job-test-org', name: 'Job Test Org', client_ref: null, tag: null, connection_status: 'connected', last_synced_at: null });
const org = getOrganisationByTenantId('job-test-org');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('a genuinely in-flight job is deduped — a second request for the same org+mode returns the existing job, not a new one', async () => {
  const gate = deferred();
  const first = startJob(`job-test-org:all::`, () => gate.promise, { tenantId: 'job-test-org', mode: 'full' });
  assert.equal(first.existing, false);

  // Give the drain loop's setImmediate a tick to move the job to 'running' before the second request.
  await new Promise(r => setImmediate(r));
  assert.equal(getJob(first.job.id).status, 'running', 'the first job must be running when the second request arrives');

  const second = startJob(`job-test-org:all::`, () => gate.promise, { tenantId: 'job-test-org', mode: 'full' });
  assert.equal(second.existing, true, 'a concurrent request for the same org+mode must dedupe to the existing job');
  assert.equal(second.job.id, first.job.id);

  gate.resolve('done');
  await new Promise(r => setImmediate(r));
  assert.equal(getJob(first.job.id).status, 'succeeded');
});

test('a different mode (a per-check reanalysis) is NOT deduped against an in-flight full sync', async () => {
  const gate = deferred();
  const full = startJob(`job-test-org:all::`, () => gate.promise, { tenantId: 'job-test-org', mode: 'full' });
  await new Promise(r => setImmediate(r));

  const check = startJob(`job-test-org:duplicate_invoices::`, () => Promise.resolve('ok'), { tenantId: 'job-test-org', mode: 'check' });
  assert.equal(check.existing, false, 'a per-check reanalysis must run independently of an in-flight full sync');
  assert.notEqual(check.job.id, full.job.id);

  gate.resolve('done');
  await new Promise(r => setImmediate(r));
});

test('a failed job records its error and status without corrupting the org or crashing the queue', async () => {
  const boom = startJob(`job-test-org:all::`, () => Promise.reject(new Error('synthetic failure: no token found')),
    { tenantId: 'job-test-org', mode: 'full' });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  const finished = getJob(boom.job.id);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /synthetic failure/);

  // The org's own connection_status must be untouched by a job failure — only an actual Xero
  // authorisation failure (isAuthorisationFailure, tested in tokenConnection.test.js) may do that.
  const orgAfter = db.prepare('SELECT connection_status FROM organisations WHERE id = ?').get(org.id);
  assert.equal(orgAfter.connection_status, 'connected');

  // The queue must still accept new jobs after a failure — the CONCURRENCY slot is released.
  const next = startJob(`job-test-org:all::`, () => Promise.resolve('recovered'), { tenantId: 'job-test-org', mode: 'full' });
  assert.equal(next.existing, false);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(getJob(next.job.id).status, 'succeeded');
});

test('cancelling a queued (not yet running) job marks it cancelled and it is never executed', async () => {
  // Occupy the single concurrency slot with an in-flight job so the next one queues instead of running.
  const gate = deferred();
  startJob(`job-test-org:all::`, () => gate.promise, { tenantId: 'job-test-org', mode: 'full' });
  await new Promise(r => setImmediate(r));

  let ranAtAll = false;
  const queued = startJob(`job-test-org:duplicate_invoices::`, () => { ranAtAll = true; return Promise.resolve('should not run'); },
    { tenantId: 'job-test-org', mode: 'check' });
  assert.equal(getJob(queued.job.id).status, 'queued');

  const cancelled = cancelJob(queued.job.id);
  assert.equal(cancelled.status, 'cancelled');

  gate.resolve('unblock the full sync');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(ranAtAll, false, 'a cancelled queued job must never execute its runner');
  assert.equal(getJob(queued.job.id).status, 'cancelled');
});

test('cancelJob refuses to cancel a job that is already running (only queued jobs can be cancelled safely)', async () => {
  const gate = deferred();
  const running = startJob(`job-test-org:all::`, () => gate.promise, { tenantId: 'job-test-org', mode: 'full' });
  await new Promise(r => setImmediate(r));
  assert.equal(getJob(running.job.id).status, 'running');

  const result = cancelJob(running.job.id);
  assert.equal(result, null, 'cancelJob must return null/refuse for a running job, matching the route\'s 409 response');
  assert.equal(getJob(running.job.id).status, 'running', 'a running job must be unaffected by a rejected cancel attempt');

  gate.resolve('done');
  await new Promise(r => setImmediate(r));
});
