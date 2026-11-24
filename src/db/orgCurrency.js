// Each client's base currency (the currency its ledger keeps its books in), one row per client.
// Verify started as UK/Xero only, so every amount was shown with "£". Zoho Books and QuickBooks
// clients can keep their books in another currency (the UAE clients are in AED), and their amounts
// are not converted, so the pages must show the client's own currency next to them.
// Kept in its own table, created by the app on first use like akrio_ledger_tokens, because the live
// akrio_organisations table is not altered. A client with no row is shown in GBP, which is what
// every Xero and FreeAgent client is today; the Zoho and QuickBooks syncs fill the row.
const { getPool } = require('./mysqlPool');

const DEFAULT_CURRENCY = 'GBP';
const CODE_RE = /^[A-Z]{3}$/;

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = getPool().query(`CREATE TABLE IF NOT EXISTS akrio_org_currency (
      org_id INT PRIMARY KEY,
      currency_code CHAR(3) NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`).catch(error => {
      tableReady = null; // try again next time rather than remember a failure
      throw error;
    });
  }
  return tableReady;
}

// An ISO 4217 code such as "AED", or null when the value is not one.
function cleanCode(code) {
  const text = String(code == null ? '' : code).trim().toUpperCase();
  return CODE_RE.test(text) ? text : null;
}

// Anything that is not a three-letter code is ignored, so a provider that sends nothing (or
// something odd) never overwrites a good value. Returns true when a row was written.
async function saveOrgCurrency(orgId, code) {
  const clean = cleanCode(code);
  if (!clean || !Number.isInteger(Number(orgId)) || Number(orgId) <= 0) return false;
  await ensureTable();
  await getPool().query(
    `INSERT INTO akrio_org_currency (org_id, currency_code) VALUES (?, ?) AS new
     ON DUPLICATE KEY UPDATE currency_code = new.currency_code`,
    [Number(orgId), clean]
  );
  return true;
}

async function getOrgCurrency(orgId) {
  await ensureTable();
  const [rows] = await getPool().query('SELECT currency_code FROM akrio_org_currency WHERE org_id = ?', [orgId]);
  return cleanCode(rows[0]?.currency_code) || DEFAULT_CURRENCY;
}

// Every requested client's currency from one query, for the all-clients pages. Clients without a
// row get GBP, so the Map always has an entry for each id asked for.
async function getOrgCurrencies(orgIds) {
  const ids = [...new Set((orgIds || []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
  const result = new Map(ids.map(id => [id, DEFAULT_CURRENCY]));
  if (!ids.length) return result;
  await ensureTable();
  const [rows] = await getPool().query(
    `SELECT org_id, currency_code FROM akrio_org_currency WHERE org_id IN (${ids.map(() => '?').join(',')})`, ids
  );
  for (const row of rows || []) {
    const clean = cleanCode(row.currency_code);
    if (clean && result.has(Number(row.org_id))) result.set(Number(row.org_id), clean);
  }
  return result;
}

module.exports = { saveOrgCurrency, getOrgCurrency, getOrgCurrencies, cleanCode, DEFAULT_CURRENCY };
