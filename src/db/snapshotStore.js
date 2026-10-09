const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { getDb } = require('./schema');
const { getPool } = require('./mysqlPool');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// The container's SQLite file is wiped on every deploy (no persistent volume). Rather than rewrite
// every query to MySQL, the tables that hold reviewer work and check results are copied into MySQL
// (akrio_sqlite_snapshot, gzip'd JSON in chunks) and loaded back into SQLite at start-up.
//
// - REVIEW tables are people's work (dismissals, notes, exclusions, statement evidence, insight
//   settings): saved every cycle (~15s) whenever they change, and again on shutdown.
// - RESULT tables are re-derivable by a sync but slow to rebuild (check results, counts): saved
//   every ~10 minutes and on shutdown.
// - Caches (xero_entity_cache, bank item cache, chart of accounts, insight_cache) are not saved.
//
// During a rolling deploy two containers overlap. A lease row decides which one saves; the other
// follows and pulls whatever the leader saved, so the new container ends up with the old one's last
// changes instead of overwriting them.
const REVIEW_TABLES = [
  'finding_review_states', 'finding_review_audit', 'finding_line_reviews', 'finding_notes',
  'contact_exclusions', 'bank_account_exclusions', 'statement_imports', 'statement_lines',
  'insight_account_mappings', 'insight_category_settings', 'insight_widget_visibility',
  'insight_settings_kv', 'insight_corp_tax_rate_bands', 'insight_corp_tax_adjustments',
  'validation_gate_assurances', 'validation_snapshots', 'validation_snapshot_checks',
  'companies_house_profile', 'filed_accounts', 'filed_accounts_extractions',
];
const RESULT_TABLES = ['issues', 'issue_findings', 'transaction_counts', 'bank_reconciliation'];
const ALL_TABLES = [...REVIEW_TABLES, ...RESULT_TABLES];

const CYCLE_MS = Number(process.env.SNAPSHOT_CYCLE_MS) || 15 * 1000;
const RESULT_EVERY_MS = Number(process.env.SNAPSHOT_RESULTS_MS) || 10 * 60 * 1000;
const LEASE_SECONDS = 45;
const PAGE_ROWS = 2000;
const CHUNK_RAW_BYTES = 3 * 1024 * 1024;

const instanceId = crypto.randomBytes(8).toString('hex');
const knownHash = new Map(); // table -> hash last saved or loaded
const seenNonEmpty = new Set(); // tables that have had rows in this process
const remoteRows = new Map(); // table -> rows in the saved copy, as last seen
let isLeader = false;
let timer = null;
let lastResultsRun = 0;
let running = false;

const enabled = () => !!process.env.AKRIO_DB_USER;
const tick = () => new Promise(resolve => setImmediate(resolve));

async function ensureTables() {
  const pool = getPool();
  await pool.query(`CREATE TABLE IF NOT EXISTS akrio_sqlite_snapshot (
    table_name VARCHAR(64) NOT NULL,
    chunk_no INT NOT NULL,
    row_count INT NOT NULL,
    data_hash CHAR(40) NOT NULL,
    payload LONGBLOB NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (table_name, chunk_no)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS akrio_snapshot_lease (
    id TINYINT NOT NULL PRIMARY KEY,
    instance_id VARCHAR(32) NOT NULL,
    heartbeat DATETIME(3) NOT NULL
  ) ENGINE=InnoDB`);
}

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

// Read a whole table in pages (yielding between pages) into gzip'd chunks plus a content hash.
async function readTable(table) {
  const db = getDb();
  const hash = crypto.createHash('sha1');
  const chunks = [];
  let batch = [];
  let batchBytes = 0;
  let total = 0;
  const flush = async () => {
    if (!batch.length) return;
    const json = JSON.stringify(batch);
    hash.update(json);
    chunks.push({ payload: await gzip(Buffer.from(json)), rows: batch.length });
    batch = [];
    batchBytes = 0;
  };
  const page = db.prepare(`SELECT rowid AS __rid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE_ROWS}`);
  let after = 0;
  for (;;) {
    const rows = page.all(after);
    if (!rows.length) break;
    for (const row of rows) {
      after = row.__rid;
      delete row.__rid;
      const size = JSON.stringify(row).length;
      if (batchBytes + size > CHUNK_RAW_BYTES) await flush();
      batch.push(row);
      batchBytes += size;
      total += 1;
    }
    await tick();
  }
  await flush();
  return { chunks, total, hash: hash.digest('hex') };
}

async function saveTable(table) {
  const db = getDb();
  if (!tableExists(db, table)) return false;
  const snap = await readTable(table);
  if (snap.total > 0) seenNonEmpty.add(table);
  if (knownHash.get(table) === snap.hash) return false;
  // Never replace a saved table with an empty one unless this process has seen it hold rows
  // (guards against a fresh, not-yet-restored container wiping the saved copy).
  if (snap.total === 0 && !seenNonEmpty.has(table) && (remoteRows.get(table) || 0) > 0) return false;
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM akrio_sqlite_snapshot WHERE table_name = ?', [table]);
    if (!snap.chunks.length) {
      await conn.query(
        'INSERT INTO akrio_sqlite_snapshot (table_name, chunk_no, row_count, data_hash, payload) VALUES (?, 0, 0, ?, ?)',
        [table, snap.hash, await gzip(Buffer.from('[]'))]
      );
    }
    for (let i = 0; i < snap.chunks.length; i++) {
      await conn.query(
        'INSERT INTO akrio_sqlite_snapshot (table_name, chunk_no, row_count, data_hash, payload) VALUES (?, ?, ?, ?, ?)',
        [table, i, snap.chunks[i].rows, snap.hash, snap.chunks[i].payload]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
  knownHash.set(table, snap.hash);
  remoteRows.set(table, snap.total);
  return true;
}

async function remoteHashes() {
  const [rows] = await getPool().query(
    'SELECT table_name, MAX(data_hash) AS data_hash, SUM(row_count) AS rows_total FROM akrio_sqlite_snapshot GROUP BY table_name'
  );
  const out = new Map();
  for (const r of rows) out.set(r.table_name, { hash: r.data_hash, rows: Number(r.rows_total) });
  return out;
}

async function loadTable(table, hash) {
  const db = getDb();
  if (!tableExists(db, table)) return 0;
  const [rows] = await getPool().query(
    'SELECT payload FROM akrio_sqlite_snapshot WHERE table_name = ? ORDER BY chunk_no', [table]
  );
  const parsed = [];
  for (const r of rows) parsed.push(...JSON.parse((await gunzip(r.payload)).toString()));
  const columns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name));
  let insert = null;
  let insertCols = null;
  db.transaction(() => {
    db.prepare(`DELETE FROM "${table}"`).run();
    for (const row of parsed) {
      const cols = Object.keys(row).filter(c => columns.has(c));
      const key = cols.join(',');
      if (key !== insertCols) {
        insert = db.prepare(`INSERT OR REPLACE INTO "${table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
        insertCols = key;
      }
      insert.run(...cols.map(c => row[c]));
    }
  })();
  knownHash.set(table, hash);
  remoteRows.set(table, parsed.length);
  if (parsed.length) seenNonEmpty.add(table);
  return parsed.length;
}

// Start-up: fill any empty local table from the saved copy.
async function restoreSnapshots() {
  if (!enabled()) return { restored: 0 };
  await ensureTables();
  const remote = await remoteHashes();
  const db = getDb();
  let restored = 0;
  for (const table of ALL_TABLES) {
    const saved = remote.get(table);
    if (!saved || !tableExists(db, table)) continue;
    remoteRows.set(table, saved.rows);
    const local = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    if (local === 0 && saved.rows > 0) restored += await loadTable(table, saved.hash);
    else if (local > 0) seenNonEmpty.add(table);
  }
  return { restored };
}

// Returns true when this container holds the lease and may save.
async function acquireLease() {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.query(
      `SELECT instance_id, heartbeat >= NOW(3) - INTERVAL ${LEASE_SECONDS} SECOND AS live FROM akrio_snapshot_lease WHERE id = 1 FOR UPDATE`
    ).then(([r]) => [r.length ? r : [undefined]]);
    let mine = false;
    if (!row) {
      await conn.query('INSERT INTO akrio_snapshot_lease (id, instance_id, heartbeat) VALUES (1, ?, NOW(3))', [instanceId]);
      mine = true;
    } else if (row.instance_id === instanceId || !Number(row.live)) {
      await conn.query('UPDATE akrio_snapshot_lease SET instance_id = ?, heartbeat = NOW(3) WHERE id = 1', [instanceId]);
      mine = true;
    }
    await conn.commit();
    return mine;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function releaseLease() {
  await getPool().query('DELETE FROM akrio_snapshot_lease WHERE id = 1 AND instance_id = ?', [instanceId]);
}

// Pull anything the leader saved that differs from what this container last saw.
async function pullChanges() {
  const remote = await remoteHashes();
  let pulled = 0;
  for (const table of ALL_TABLES) {
    const saved = remote.get(table);
    if (!saved || knownHash.get(table) === saved.hash) continue;
    // An empty saved copy must not wipe local rows this process has never synced.
    if (saved.rows === 0 && !knownHash.has(table) && tableExists(getDb(), table)
      && getDb().prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n > 0) continue;
    pulled += await loadTable(table, saved.hash);
  }
  return pulled;
}

async function saveTables(tables) {
  let saved = 0;
  for (const table of tables) {
    try { if (await saveTable(table)) saved += 1; }
    catch (err) { console.error(`[snapshot] saving ${table} failed:`, err.message); }
  }
  return saved;
}

async function runCycle({ force = false } = {}) {
  if (!enabled() || running) return;
  running = true;
  try {
    const leader = await acquireLease();
    if (!leader) {
      isLeader = false;
      await pullChanges();
      return;
    }
    if (!isLeader) { await pullChanges(); isLeader = true; }
    await saveTables(REVIEW_TABLES);
    if (force || Date.now() - lastResultsRun >= RESULT_EVERY_MS) {
      await saveTables(RESULT_TABLES);
      lastResultsRun = Date.now();
    }
  } catch (err) {
    console.error('[snapshot] cycle failed:', err.message);
  } finally {
    running = false;
  }
}

function startSnapshotSync() {
  if (!enabled() || timer) return;
  lastResultsRun = Date.now();
  timer = setInterval(() => runCycle(), CYCLE_MS);
  timer.unref();
  const shutdown = async signal => {
    console.log(`[snapshot] ${signal} received, saving before exit`);
    clearInterval(timer);
    const deadline = new Promise(resolve => setTimeout(resolve, 20000));
    await Promise.race([
      (async () => {
        while (running) await new Promise(r => setTimeout(r, 100));
        if (isLeader) { await saveTables(REVIEW_TABLES); await saveTables(RESULT_TABLES); await releaseLease(); }
      })().catch(err => console.error('[snapshot] shutdown save failed:', err.message)),
      deadline,
    ]);
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  REVIEW_TABLES, RESULT_TABLES, restoreSnapshots, startSnapshotSync, runCycle, saveTable, loadTable,
  _resetForTests: () => { knownHash.clear(); seenNonEmpty.clear(); remoteRows.clear(); isLeader = false; },
};
