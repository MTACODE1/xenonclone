// Readings of Zoho Books' Banking page taken by the Akrio Verify browser extension. One batch per read of one
// organisation, one row per bank account in it; history is kept and the newest batch is shown. Their own tables
// (created by the app on first use, like the Xero bank-screen tables) so the Xero readings, and everything that
// reads them, stay exactly as they are.
const { getPool } = require('./mysqlPool');
const { booksHostFromApiDomain } = require('../services/zohoBankScreenReading');

let tableReady = null;
function ensureZohoTables(pool = getPool()) {
  if (!tableReady) {
    tableReady = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS akrio_zoho_bank_screen_batches (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        org_id INT NOT NULL,
        zoho_org_id VARCHAR(20) NOT NULL,
        books_host VARCHAR(40) NULL,
        page_title VARCHAR(200) NULL,
        summary_total INT NULL,
        account_count SMALLINT NOT NULL,
        read_by_staff_id INT NULL,
        read_by_name VARCHAR(255) NULL,
        read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_zoho_bank_screen_batches_org (org_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS akrio_zoho_bank_screen_accounts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        batch_id BIGINT NOT NULL,
        org_id INT NOT NULL,
        position SMALLINT NOT NULL,
        account_name VARCHAR(255) NOT NULL,
        account_number VARCHAR(64) NULL,
        uncategorised INT NOT NULL,
        currency VARCHAR(8) NULL,
        amount_in_bank DECIMAL(18,3) NOT NULL,
        amount_in_books DECIMAL(18,3) NOT NULL,
        UNIQUE KEY uq_zoho_bank_screen_account (batch_id, position),
        KEY idx_zoho_bank_screen_accounts_org (org_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    })().catch(err => { tableReady = null; throw err; });
  }
  return tableReady;
}

// reading must already have been through validateZohoReading. Batch and rows are written together or not at all.
async function saveZohoReading(orgId, reading, staff = {}, { pool = getPool(), ensure = ensureZohoTables } = {}) {
  if (!Number.isInteger(orgId)) throw new Error('saveZohoReading needs the organisation id');
  await ensure(pool);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO akrio_zoho_bank_screen_batches (org_id, zoho_org_id, books_host, page_title, summary_total, account_count,
         read_by_staff_id, read_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, reading.orgId, reading.booksHost, reading.pageTitle, reading.summaryTotal, reading.accounts.length,
        staff.id ?? null, staff.name ?? null]
    );
    const batchId = result.insertId;
    await connection.query(
      `INSERT INTO akrio_zoho_bank_screen_accounts (batch_id, org_id, position, account_name, account_number, uncategorised,
         currency, amount_in_bank, amount_in_books) VALUES ?`,
      [reading.accounts.map((account, index) => [
        batchId, orgId, index, account.accountName, account.accountNumber, account.uncategorised, account.currency,
        account.amountInBank, account.amountInBooks,
      ])]
    );
    await connection.commit();
    return batchId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

const num = value => (value == null ? null : Number(value));

async function getLatestZohoReading(orgId, { pool = getPool(), ensure = ensureZohoTables } = {}) {
  await ensure(pool);
  const [batches] = await pool.query(
    `SELECT id, zoho_org_id, books_host, page_title, summary_total, read_by_name, UNIX_TIMESTAMP(read_at) AS read_at_unix
     FROM akrio_zoho_bank_screen_batches WHERE org_id = ? ORDER BY id DESC LIMIT 1`, [orgId]
  );
  if (!batches.length) return null;
  const batch = batches[0];
  const [rows] = await pool.query(
    `SELECT account_name, account_number, uncategorised, currency, amount_in_bank, amount_in_books
     FROM akrio_zoho_bank_screen_accounts WHERE batch_id = ? AND org_id = ? ORDER BY position`, [batch.id, orgId]
  );
  return {
    batchId: batch.id, zohoOrgId: batch.zoho_org_id, booksHost: batch.books_host, pageTitle: batch.page_title,
    summaryTotal: batch.summary_total == null ? null : Number(batch.summary_total), readByName: batch.read_by_name,
    // UNIX_TIMESTAMP gives the instant itself, so it does not depend on how the connection formats dates.
    readAt: new Date(Number(batch.read_at_unix) * 1000),
    accounts: rows.map(row => ({
      accountName: row.account_name, accountNumber: row.account_number, uncategorised: Number(row.uncategorised),
      currency: row.currency, amountInBank: num(row.amount_in_bank), amountInBooks: num(row.amount_in_books),
    })),
  };
}

// When each organisation's Banking page was last read: Map(orgId -> Date). Lets an "update all" run carry on
// where an interrupted one stopped.
async function getZohoLastReadTimes({ pool = getPool(), ensure = ensureZohoTables } = {}) {
  await ensure(pool);
  const [rows] = await pool.query(
    `SELECT org_id, UNIX_TIMESTAMP(MAX(read_at)) AS read_at_unix FROM akrio_zoho_bank_screen_batches GROUP BY org_id`
  );
  return new Map(rows.map(row => [Number(row.org_id), new Date(Number(row.read_at_unix) * 1000)]));
}

// Zoho organisation id -> the Books web address of its data centre, from the API domain Zoho named when the client
// was connected. Read only; a missing token table or an unknown domain simply gives no entry (the extension then
// opens books.zoho.com).
async function getZohoBooksHosts({ pool = getPool() } = {}) {
  try {
    const [rows] = await pool.query(`SELECT external_id, api_domain FROM akrio_ledger_tokens WHERE provider = 'zoho'`);
    const hosts = new Map();
    for (const row of rows) {
      const host = booksHostFromApiDomain(row.api_domain);
      if (host) hosts.set(String(row.external_id), host);
    }
    return hosts;
  } catch (error) {
    return new Map();
  }
}

module.exports = { ensureZohoTables, saveZohoReading, getLatestZohoReading, getZohoLastReadTimes, getZohoBooksHosts };
