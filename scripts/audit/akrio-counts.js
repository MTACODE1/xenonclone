// Read-only: Akrio's latest per-client, per-check issue counts, taken from the MySQL snapshot of the
// issues table (what the live app saved), so no Xero calls and no running app are needed.
// Usage: node scripts/audit/akrio-counts.js <out.json>
require('dotenv').config();
const fs = require('fs');
const zlib = require('zlib');
const { getPool } = require('../../src/db/mysqlPool');

(async () => {
  const pool = getPool();
  const [chunks] = await pool.query("SELECT payload FROM akrio_sqlite_snapshot WHERE table_name = 'issues' ORDER BY chunk_no");
  const issues = chunks.flatMap(c => JSON.parse(zlib.gunzipSync(c.payload).toString()));
  const [orgs] = await pool.query('SELECT id, name, xero_tenant_id, connection_status, last_synced_at FROM akrio_organisations');
  const byId = new Map(orgs.map(o => [o.id, o]));
  const out = {};
  for (const i of issues) {
    const o = byId.get(i.org_id);
    if (!o) continue;
    out[o.name] ??= { tenant: o.xero_tenant_id, status: o.connection_status, lastSynced: o.last_synced_at, checks: {} };
    const prev = out[o.name].checks[i.check_type];
    if (prev && String(prev.syncedAt) >= String(i.synced_at)) continue;   // keep the newest row per check
    out[o.name].checks[i.check_type] = { count: i.count, value: i.potential_value_gbp, period: i.period_checked, syncedAt: i.synced_at };
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(out));
  console.log(`${Object.keys(out).length} clients, ${issues.length} check rows`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
