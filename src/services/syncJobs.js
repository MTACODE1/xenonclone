const crypto = require('crypto');
const { getPool } = require('../db/mysqlPool');

// sync_jobs migrated to the shared MySQL database (akrio_sync_jobs). The job-claiming logic
// below was rewritten for this: under synchronous SQLite, a SELECT-then-UPDATE pair inside
// drain() couldn't be interleaved by anything else (single-threaded, no `await` between them),
// so it safely claimed one job at a time. Under async MySQL, any `await` yields to the event
// loop, and drain() CAN run concurrently with itself (schedule() can fire again while a previous
// drain() is still awaiting a query) — a plain SELECT-then-UPDATE would let two overlapping
// drain() calls both claim the same queued job. claimNextJob() below fixes this with an
// optimistic conditional UPDATE (`WHERE id = ? AND status = 'queued'`, checking affectedRows)
// instead — MySQL's row locking during that single statement is what makes it atomic, not
// application-level sequencing.

const listeners = new Map();
const runners = new Map();
const MAX_JOBS = Math.max(10, Number(process.env.SYNC_JOB_HISTORY_LIMIT) || 200);
const CONCURRENCY = Math.max(1, Number(process.env.SYNC_CONCURRENCY) || 1);
let active = 0;
let scheduled = false;

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    key: job.dedupe_key,
    status: job.status,
    progress: parse(job.progress_json),
    result: parse(job.result_json),
    error: job.error,
    attempt: job.attempt,
    maxAttempts: job.max_attempts,
    createdAt: job.created_at,
    startedAt: job.started_at,
    progressAt: job.progress_at,
    finishedAt: job.finished_at,
  };
}

function parse(value) {
  if (!value) return null;
  if (typeof value === 'object') return value; // mysql2 returns JSON columns already parsed
  try { return JSON.parse(value); } catch (error) { return null; }
}

async function pruneJobs() {
  await getPool().query(`
    DELETE FROM akrio_sync_jobs WHERE id IN (
      SELECT id FROM (
        SELECT id FROM akrio_sync_jobs WHERE status IN ('succeeded', 'failed', 'cancelled')
        ORDER BY finished_at DESC LIMIT 18446744073709551615 OFFSET ?
      ) AS old
    )
  `, [MAX_JOBS]);
}

async function publish(id) {
  const snapshot = await getJob(id);
  for (const listener of listeners.get(id) || []) listener(snapshot);
}

function transient(error) {
  return !!error && (
    error.statusCode === 429 || error.statusCode >= 500 ||
    /429|rate.?limit|timeout|timed out|ECONNRESET|EAI_AGAIN|temporar/i.test(error.message || '')
  );
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    drain().catch(error => console.error('[syncJobs] drain failed:', error.message));
  });
}

// Finds one claimable job (queued, due, no other job already running for the same org) and
// atomically marks it running. Returns null if there's nothing to claim OR if another
// concurrent drain() claimed it first (affectedRows === 0) — either way the caller just stops
// this pass; schedule() will fire again soon regardless (job completion, or a new startJob()).
async function claimNextJob() {
  const pool = getPool();
  const [candidates] = await pool.query(`
    SELECT id FROM akrio_sync_jobs
    WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      AND NOT EXISTS (
        SELECT 1 FROM akrio_sync_jobs running
        WHERE running.org_id = akrio_sync_jobs.org_id AND running.status = 'running'
      )
    ORDER BY created_at, id LIMIT 1
  `);
  if (!candidates.length) return null;
  const candidateId = candidates[0].id;
  const [result] = await pool.query(`
    UPDATE akrio_sync_jobs SET status = 'running', attempt = attempt + 1,
      started_at = COALESCE(started_at, CURRENT_TIMESTAMP), progress_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'queued'
  `, [candidateId]);
  if (result.affectedRows !== 1) return null;
  const [rows] = await pool.query(`SELECT * FROM akrio_sync_jobs WHERE id = ?`, [candidateId]);
  return rows[0] || null;
}

async function drain() {
  while (active < CONCURRENCY) {
    const job = await claimNextJob();
    if (!job) break;
    const payload = parse(job.payload_json);
    const runner = runners.get(job.id) || (payload?.period
      ? progress => require('./xeroSync').syncOrganisation(job.tenant_id, progress, payload)
      : null);
    if (!runner) {
      await getPool().query(`
        UPDATE akrio_sync_jobs SET status = 'failed', error = ?,
          finished_at = CURRENT_TIMESTAMP WHERE id = ?
      `, ['Queued job cannot resume after process restart; enqueue it again safely.', job.id]);
      await publish(job.id);
      continue;
    }
    active++;
    await publish(job.id);
    Promise.resolve().then(() => runner(event => {
      getPool().query(`
        UPDATE akrio_sync_jobs SET progress_json = ?, progress_at = CURRENT_TIMESTAMP WHERE id = ?
      `, [JSON.stringify(event), job.id])
        .then(() => publish(job.id))
        .catch(error => console.error('[syncJobs] progress update failed:', error.message));
    })).then(async result => {
      await getPool().query(`
        UPDATE akrio_sync_jobs SET status = 'succeeded', result_json = ?, error = NULL,
          finished_at = CURRENT_TIMESTAMP, progress_at = CURRENT_TIMESTAMP WHERE id = ?
      `, [JSON.stringify(result ?? null), job.id]);
      runners.delete(job.id);
      await publish(job.id);
    }).catch(async error => {
      const [latestRows] = await getPool().query(
        `SELECT attempt, max_attempts FROM akrio_sync_jobs WHERE id = ?`, [job.id]
      );
      const latest = latestRows[0];
      if (transient(error) && latest.attempt < latest.max_attempts) {
        const delaySeconds = Math.min(60, 2 ** latest.attempt);
        await getPool().query(`
          UPDATE akrio_sync_jobs SET status = 'queued', error = ?,
            next_attempt_at = DATE_ADD(NOW(), INTERVAL ? SECOND), progress_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [error.message, delaySeconds, job.id]);
        setTimeout(schedule, delaySeconds * 1000 + 25);
      } else {
        await getPool().query(`
          UPDATE akrio_sync_jobs SET status = 'failed', error = ?,
            finished_at = CURRENT_TIMESTAMP, progress_at = CURRENT_TIMESTAMP WHERE id = ?
        `, [error.message, job.id]);
        runners.delete(job.id);
      }
      await publish(job.id);
    }).finally(async () => {
      active--;
      await pruneJobs().catch(error => console.error('[syncJobs] prune failed:', error.message));
      schedule();
    });
  }
}

async function startJob(key, runner, options = {}) {
  const pool = getPool();
  const tenantId = options.tenantId || String(key).split(':')[0];
  let org;
  if (options.orgId) {
    org = { id: options.orgId };
  } else {
    const [rows] = await pool.query(
      `SELECT id FROM akrio_organisations WHERE xero_tenant_id = ?`, [tenantId]
    );
    org = rows[0];
  }
  if (!org) throw new Error('Organisation not found');
  const mode = options.mode || (String(key).includes(':all:') ? 'full' : 'check');
  const [existingRows] = await pool.query(
    `SELECT * FROM akrio_sync_jobs WHERE org_id = ? AND mode = ? AND status IN ('queued', 'running')`,
    [org.id, mode]
  );
  if (existingRows.length) return { job: publicJob(existingRows[0]), existing: true };
  const id = crypto.randomUUID();
  await pool.query(`
    INSERT INTO akrio_sync_jobs
      (id, org_id, tenant_id, mode, dedupe_key, status, max_attempts, payload_json, progress_json)
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
  `, [
    id, org.id, tenantId, mode, key,
    Math.max(1, Number(options.maxAttempts) || 3),
    JSON.stringify(options.payload || null),
    JSON.stringify({ step: 'queued', message: 'Waiting to start...' }),
  ]);
  runners.set(id, runner);
  schedule();
  return { job: await getJob(id), existing: false };
}

async function getJob(id) {
  const [rows] = await getPool().query(`SELECT * FROM akrio_sync_jobs WHERE id = ?`, [id]);
  return publicJob(rows[0]);
}

// For the Client List page on load: without this, a queued/running job is invisible after a
// refresh (or to anyone who didn't personally click Sync) until it finishes, since the live
// progress stream only exists in the browser tab that started it. Returns a Map keyed by org_id
// so a page rendering many orgs can look up "is there one already in flight" per row in one query
// instead of one query per org.
async function getActiveJobsByOrg() {
  const [rows] = await getPool().query(
    `SELECT * FROM akrio_sync_jobs WHERE status IN ('queued', 'running') ORDER BY created_at`
  );
  const byOrg = new Map();
  for (const row of rows) {
    if (!byOrg.has(row.org_id)) byOrg.set(row.org_id, publicJob(row));
  }
  return byOrg;
}

async function subscribe(id, listener) {
  const job = await getJob(id);
  if (!job) return null;
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(listener);
  listener(job);
  return () => {
    listeners.get(id)?.delete(listener);
    if (!listeners.get(id)?.size) listeners.delete(id);
  };
}

async function cancelJob(id) {
  const [result] = await getPool().query(`
    UPDATE akrio_sync_jobs SET status = 'cancelled', error = 'Cancelled before start',
      finished_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'queued'
  `, [id]);
  if (result.affectedRows) {
    runners.delete(id);
    await publish(id);
    return getJob(id);
  }
  return null;
}

// Runs once at module load: any job left 'running' from a previous process (crash/restart)
// couldn't have a registered runner (runners is in-memory), so it can never resume — reset it
// to queued so drain() reports it can't resume (see the `!runner` branch above) instead of
// leaving it stuck showing "running" forever.
(async () => {
  try {
    await getPool().query(`
      UPDATE akrio_sync_jobs SET status = 'queued', error = 'Process restarted while job was running',
        next_attempt_at = CURRENT_TIMESTAMP WHERE status = 'running'
    `);
    schedule();
  } catch (error) {
    console.error('[syncJobs] Failed to reset stuck jobs on boot:', error.message);
  }
})();

module.exports = { cancelJob, getActiveJobsByOrg, getJob, startJob, subscribe, transient };
