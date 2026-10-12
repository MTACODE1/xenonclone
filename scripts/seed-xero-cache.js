// One-off: copies a saved SQLite database's xero_entity_cache into MySQL (akrio_xero_cache) so the first
// sync after the persistent-cache release is incremental instead of a full Xero download.
// Existing MySQL rows are never overwritten (INSERT IGNORE), so it is safe to re-run.
// Usage: node scripts/seed-xero-cache.js <path to xero_dashboard.db>
require('dotenv').config();
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { getPool } = require('../src/db/mysqlPool');
const { ensureTable } = require('../src/db/xeroCacheStore');

const toMysql = v => (v ? new Date(v).toISOString().slice(0, 23).replace('T', ' ') : null);

(async () => {
  const sqlite = new Database(process.argv[2], { readonly: true, fileMustExist: true });
  await ensureTable();
  const pool = getPool();
  const [orgs] = await pool.query('SELECT id, xero_tenant_id FROM akrio_organisations');
  const byTenant = new Map(orgs.map(o => [o.xero_tenant_id, o.id]));
  // The saved database predates the move of clients to MySQL, so its org ids differ. Each saved client's own
  // 'organisation' record carries the Xero tenant id, which is what links it to a current client.
  const saved = sqlite.prepare("SELECT org_id, json_extract(json, '$.organisationID') AS tenant, json_extract(json, '$.name') AS name FROM xero_entity_cache WHERE entity_type = 'organisation'").all();
  const map = new Map();
  for (const o of saved) if (byTenant.has(o.tenant)) map.set(o.org_id, byTenant.get(o.tenant));
  console.log(`${map.size} of ${saved.length} saved clients match a current client`);

  const stmt = sqlite.prepare('SELECT org_id, entity_type, entity_id, json, modified_at, fetched_at FROM xero_entity_cache WHERE org_id = ? ORDER BY entity_type, entity_id');
  let total = 0;
  for (const [localId, mysqlId] of map) {
    let batch = [], n = 0;
    const flush = async () => {
      if (!batch.length) return;
      await pool.query('INSERT IGNORE INTO akrio_xero_cache (org_id, entity_type, entity_id, modified_at, fetched_at, payload) VALUES ?', [batch]);
      n += batch.length; batch = [];
    };
    for (const r of stmt.iterate(localId)) {
      batch.push([mysqlId, r.entity_type, String(r.entity_id).slice(0, 64), toMysql(r.modified_at), toMysql(r.fetched_at), zlib.gzipSync(r.json)]);
      if (batch.length >= 400) await flush();
    }
    await flush();
    total += n;
    console.log(`org ${mysqlId}: ${n} records (total ${total})`);
  }
  console.log('done', total);
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
