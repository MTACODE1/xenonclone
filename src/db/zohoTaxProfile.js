// Each Zoho Books client's tax profile (VAT registration, TRN, free zone flags) and region, one row per client.
// The sync reads it from Zoho's organisation answer; a cache-only re-run does not call Zoho, so the checks need the
// last copy to know whether a client is a UAE company and VAT registered. The client page reads the same row to show
// UAE labels and the UAE Tax Registration card.
// Kept in its own table, created by the app on first use like akrio_org_currency, because the live
// akrio_organisations table is not altered. Xero clients never get a row.
const { getPool } = require('./mysqlPool');

let tableReady = null;
function ensureTable(pool = getPool()) {
  if (!tableReady) {
    tableReady = pool.query(`CREATE TABLE IF NOT EXISTS akrio_zoho_tax_profile (
      org_id INT PRIMARY KEY,
      region VARCHAR(8) NULL,
      profile_json TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`).catch(error => {
      tableReady = null; // try again next time rather than remember a failure
      throw error;
    });
  }
  return tableReady;
}

const REGION_RE = /^[A-Z]{2}$/;

// Saves what the sync worked out. A missing profile is not written, so a cache-only run never wipes a good copy.
async function saveZohoTaxProfile(orgId, { region = null, profile = null } = {}, { pool = getPool() } = {}) {
  if (!Number.isInteger(Number(orgId)) || Number(orgId) <= 0 || !profile || typeof profile !== 'object') return false;
  await ensureTable(pool);
  const cleanRegion = REGION_RE.test(String(region || '')) ? String(region) : null;
  await pool.query(
    `INSERT INTO akrio_zoho_tax_profile (org_id, region, profile_json) VALUES (?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE region = new.region, profile_json = new.profile_json`,
    [Number(orgId), cleanRegion, JSON.stringify(profile)]
  );
  return true;
}

// { region, profile } or null when the client has no row (or the row cannot be read as JSON).
async function getZohoTaxProfile(orgId, { pool = getPool() } = {}) {
  await ensureTable(pool);
  const [rows] = await pool.query('SELECT region, profile_json FROM akrio_zoho_tax_profile WHERE org_id = ?', [orgId]);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  try {
    const profile = JSON.parse(row.profile_json);
    return { region: REGION_RE.test(String(row.region || '')) ? row.region : null, profile: profile && typeof profile === 'object' ? profile : null };
  } catch (error) {
    return null;
  }
}

module.exports = { ensureTable, saveZohoTaxProfile, getZohoTaxProfile };
