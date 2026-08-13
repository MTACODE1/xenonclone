const crypto = require('crypto');
const { getDb } = require('../db/schema');

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
  try { return JSON.parse(value); } catch (error) { return null; }
}

function pruneJobs() {
  getDb().prepare(`
    DELETE FROM sync_jobs WHERE id IN (
      SELECT id FROM sync_jobs WHERE status IN ('succeeded', 'failed', 'cancelled')
      ORDER BY finished_at DESC LIMIT -1 OFFSET ?
    )
  `).run(MAX_JOBS);
}

function publish(id) {
  const snapshot = getJob(id);
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
    drain();
  });
}

function drain() {
  const db = getDb();
  while (active < CONCURRENCY) {
    const job = db.prepare(`
      SELECT * FROM sync_jobs
      WHERE status = 'queued' AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))
        AND NOT EXISTS (
          SELECT 1 FROM sync_jobs running
          WHERE running.org_id = sync_jobs.org_id AND running.status = 'running'
        )
      ORDER BY created_at, id LIMIT 1
    `).get();
    if (!job) break;
    const payload = parse(job.payload_json);
    const runner = runners.get(job.id) || (payload?.period
      ? progress => require('./xeroSync').syncOrganisation(job.tenant_id, progress, payload)
      : null);
    if (!runner) {
      db.prepare(`
        UPDATE sync_jobs SET status = 'failed', error = ?,
          finished_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run('Queued job cannot resume after process restart; enqueue it again safely.', job.id);
      publish(job.id);
      continue;
    }
    db.prepare(`
      UPDATE sync_jobs SET status = 'running', attempt = attempt + 1,
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP), progress_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(job.id);
    active++;
    publish(job.id);
    Promise.resolve().then(() => runner(event => {
      db.prepare(`
        UPDATE sync_jobs SET progress_json = ?, progress_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(JSON.stringify(event), job.id);
      publish(job.id);
    })).then(result => {
      db.prepare(`
        UPDATE sync_jobs SET status = 'succeeded', result_json = ?, error = NULL,
          finished_at = CURRENT_TIMESTAMP, progress_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(JSON.stringify(result ?? null), job.id);
      runners.delete(job.id);
      publish(job.id);
    }).catch(error => {
      const latest = db.prepare(`SELECT attempt, max_attempts FROM sync_jobs WHERE id = ?`).get(job.id);
      if (transient(error) && latest.attempt < latest.max_attempts) {
        const delaySeconds = Math.min(60, 2 ** latest.attempt);
        db.prepare(`
          UPDATE sync_jobs SET status = 'queued', error = ?,
            next_attempt_at = datetime('now', ?), progress_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(error.message, `+${delaySeconds} seconds`, job.id);
        setTimeout(schedule, delaySeconds * 1000 + 25);
      } else {
        db.prepare(`
          UPDATE sync_jobs SET status = 'failed', error = ?,
            finished_at = CURRENT_TIMESTAMP, progress_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(error.message, job.id);
        runners.delete(job.id);
      }
      publish(job.id);
    }).finally(() => {
      active--;
      pruneJobs();
      schedule();
    });
  }
}

function startJob(key, runner, options = {}) {
  const db = getDb();
  const tenantId = options.tenantId || String(key).split(':')[0];
  const org = options.orgId
    ? { id: options.orgId }
    : db.prepare(`SELECT id FROM organisations WHERE xero_tenant_id = ?`).get(tenantId);
  if (!org) throw new Error('Organisation not found');
  const mode = options.mode || (String(key).includes(':all:') ? 'full' : 'check');
  const existing = db.prepare(`
    SELECT * FROM sync_jobs WHERE org_id = ? AND mode = ? AND status IN ('queued', 'running')
  `).get(org.id, mode);
  if (existing) return { job: publicJob(existing), existing: true };
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO sync_jobs
      (id, org_id, tenant_id, mode, dedupe_key, status, max_attempts, payload_json, progress_json)
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
  `).run(
    id, org.id, tenantId, mode, key,
    Math.max(1, Number(options.maxAttempts) || 3),
    JSON.stringify(options.payload || null),
    JSON.stringify({ step: 'queued', message: 'Waiting to start...' })
  );
  runners.set(id, runner);
  schedule();
  return { job: getJob(id), existing: false };
}

function getJob(id) {
  return publicJob(getDb().prepare(`SELECT * FROM sync_jobs WHERE id = ?`).get(id));
}

function subscribe(id, listener) {
  if (!getJob(id)) return null;
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(listener);
  listener(getJob(id));
  return () => {
    listeners.get(id)?.delete(listener);
    if (!listeners.get(id)?.size) listeners.delete(id);
  };
}

function cancelJob(id) {
  const result = getDb().prepare(`
    UPDATE sync_jobs SET status = 'cancelled', error = 'Cancelled before start',
      finished_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'queued'
  `).run(id);
  if (result.changes) {
    runners.delete(id);
    publish(id);
    return getJob(id);
  }
  return null;
}

getDb().prepare(`
  UPDATE sync_jobs SET status = 'queued', error = 'Process restarted while job was running',
    next_attempt_at = CURRENT_TIMESTAMP WHERE status = 'running'
`).run();
schedule();

module.exports = { cancelJob, getJob, startJob, subscribe, transient };
