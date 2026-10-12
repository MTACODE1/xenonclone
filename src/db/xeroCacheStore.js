// Durable copy of the raw Xero data cache (xero_entity_cache) in MySQL.
//
// The container's SQLite file is wiped on every deploy, and the checks read the raw Xero data from
// that cache, so after a deploy every client had to be downloaded from Xero again (3-4 hours). Here
// SQLite stays the fast working copy the checks read, but:
//   - every write to it is also saved to MySQL (write-behind, compressed), and
//   - the first time a client is needed after a restart, its rows are loaded back from MySQL
//     (hydrateOrgIfEmpty), so the next sync only asks Xero for what changed.
const zlib = require('zlib');
const { getDb } = require('./schema');
const { getPool } = require('./mysqlPool');

const enabled = () => !!process.env.AKRIO_DB_USER;
const BATCH = 400;

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = getPool().query(`CREATE TABLE IF NOT EXISTS akrio_xero_cache (
      org_id INT NOT NULL,
      entity_type VARCHAR(24) NOT NULL,
      entity_id VARCHAR(64) NOT NULL,
      modified_at DATETIME(3) NULL,
      fetched_at DATETIME(3) NOT NULL,
      payload MEDIUMBLOB NOT NULL,
      PRIMARY KEY (org_id, entity_type, entity_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`).catch(err => { tableReady = null; throw err; });
  }
  return tableReady;
}

const toMysqlDate = value => (value ? new Date(value).toISOString().slice(0, 23).replace('T', ' ') : null);
const fromMysqlDate = value => (value ? new Date(`${String(value).replace(' ', 'T')}Z`).toISOString() : null);

// ---- write-behind ----
// Jobs run one after another so two saves for the same client never interleave. A failed save is
// logged and skipped; the next sync re-saves whatever changed, so a missed write costs time, not data.
let chain = Promise.resolve();
function enqueue(job) {
  chain = chain.then(job).catch(err => console.error('[xero-cache] save failed:', err.message));
  return chain;
}

// entries: [{ id, json, modifiedAt }]; fullRefresh also removes rows that are no longer in Xero.
function queueSave(orgId, entityType, entries, fetchedAt, fullRefresh) {
  if (!enabled() || (!entries.length && !fullRefresh)) return chain;
  return enqueue(async () => {
    await ensureTable();
    const pool = getPool();
    const fetched = toMysqlDate(fetchedAt);
    for (let i = 0; i < entries.length; i += BATCH) {
      const rows = entries.slice(i, i + BATCH).map(e => [
        orgId, entityType, String(e.id).slice(0, 64), toMysqlDate(e.modifiedAt), fetched, zlib.gzipSync(e.json),
      ]);
      await pool.query(
        `INSERT INTO akrio_xero_cache (org_id, entity_type, entity_id, modified_at, fetched_at, payload) VALUES ?
         ON DUPLICATE KEY UPDATE modified_at = VALUES(modified_at), fetched_at = VALUES(fetched_at), payload = VALUES(payload)`,
        [rows]
      );
    }
    // Only drop rows after a complete re-download, and never when it returned nothing at all.
    if (fullRefresh && entries.length) {
      await pool.query(
        'DELETE FROM akrio_xero_cache WHERE org_id = ? AND entity_type = ? AND fetched_at < ?',
        [orgId, entityType, fetched]
      );
    }
  });
}

const drain = () => chain;

// ---- restore ----
const hydrated = new Set();   // orgs already checked in this process
async function hydrateOrgIfEmpty(orgId) {
  if (!enabled() || hydrated.has(orgId)) return 0;
  const db = getDb();
  const has = db.prepare('SELECT 1 FROM xero_entity_cache WHERE org_id = ? LIMIT 1').get(orgId);
  if (has) { hydrated.add(orgId); return 0; }
  await ensureTable();
  const pool = getPool();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO xero_entity_cache (org_id, entity_type, entity_id, json, modified_at, fetched_at, source_run_id)
    VALUES (?, ?, ?, ?, ?, ?, NULL)`);
  let total = 0, lastType = '', lastId = '';
  for (;;) {
    const [rows] = await pool.query(
      `SELECT entity_type, entity_id, modified_at, fetched_at, payload FROM akrio_xero_cache
        WHERE org_id = ? AND (entity_type > ? OR (entity_type = ? AND entity_id > ?))
        ORDER BY entity_type, entity_id LIMIT 2000`,
      [orgId, lastType, lastType, lastId]
    );
    if (!rows.length) break;
    db.transaction(() => {
      for (const r of rows) {
        insert.run(orgId, r.entity_type, r.entity_id, zlib.gunzipSync(r.payload).toString(),
          fromMysqlDate(r.modified_at), fromMysqlDate(r.fetched_at));
      }
    })();
    total += rows.length;
    lastType = rows[rows.length - 1].entity_type;
    lastId = rows[rows.length - 1].entity_id;
    await new Promise(resolve => setImmediate(resolve));   // let other requests run
  }
  hydrated.add(orgId);
  if (total) console.log(`[xero-cache] restored ${total} cached records for org ${orgId} from MySQL`);
  return total;
}

module.exports = { queueSave, drain, hydrateOrgIfEmpty, ensureTable };
