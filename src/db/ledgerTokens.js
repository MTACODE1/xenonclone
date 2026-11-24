// Sign-in tokens for QuickBooks and Zoho Books clients, one row per client (provider + its id).
// Created by the app itself on first use, like the bank-screen tables, so no manual database step
// is needed. Xero and FreeAgent keep their own token tables.
const { getPool } = require('./mysqlPool');

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = getPool().query(`CREATE TABLE IF NOT EXISTS akrio_ledger_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      provider VARCHAR(20) NOT NULL,
      external_id VARCHAR(100) NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      refresh_expires_at DATETIME NULL,
      api_domain VARCHAR(255) NULL,
      accounts_server VARCHAR(255) NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ledger_tokens (provider, external_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`).catch(error => {
      tableReady = null; // try again next time rather than remember a failure
      throw error;
    });
  }
  return tableReady;
}

function toMysqlDate(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// The pool returns DATETIME as "YYYY-MM-DD HH:MM:SS" text (dateStrings), and these are written in
// UTC, so they are handed back as ISO strings with a Z: new Date() then reads them correctly on a
// server in any time zone.
function asUtcIso(value) {
  if (value == null || value === '') return value;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text;
}

async function getLedgerToken(provider, externalId) {
  await ensureTable();
  const [rows] = await getPool().query(
    'SELECT * FROM akrio_ledger_tokens WHERE provider = ? AND external_id = ?', [provider, String(externalId)]
  );
  const row = rows[0];
  return row ? { ...row, expires_at: asUtcIso(row.expires_at), refresh_expires_at: asUtcIso(row.refresh_expires_at) } : null;
}

async function saveLedgerToken(provider, externalId, token) {
  await ensureTable();
  await getPool().query(
    `INSERT INTO akrio_ledger_tokens
       (provider, external_id, access_token, refresh_token, expires_at, refresh_expires_at, api_domain, accounts_server)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE
       access_token = new.access_token,
       refresh_token = new.refresh_token,
       expires_at = new.expires_at,
       refresh_expires_at = COALESCE(new.refresh_expires_at, akrio_ledger_tokens.refresh_expires_at),
       api_domain = COALESCE(new.api_domain, akrio_ledger_tokens.api_domain),
       accounts_server = COALESCE(new.accounts_server, akrio_ledger_tokens.accounts_server),
       updated_at = CURRENT_TIMESTAMP`,
    [provider, String(externalId), token.access_token, token.refresh_token,
      toMysqlDate(token.expires_at) || toMysqlDate(new Date(Date.now() + 30 * 60 * 1000)),
      toMysqlDate(token.refresh_expires_at), token.api_domain || null, token.accounts_server || null]
  );
}

async function deleteLedgerToken(provider, externalId) {
  await ensureTable();
  await getPool().query('DELETE FROM akrio_ledger_tokens WHERE provider = ? AND external_id = ?', [provider, String(externalId)]);
}

module.exports = { getLedgerToken, saveLedgerToken, deleteLedgerToken, toMysqlDate, asUtcIso };
