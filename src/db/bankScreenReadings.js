// Readings of Xero's "Bank accounts" page taken by the Akrio Verify browser extension. One batch per
// read of one organisation, one row per bank account in it. History is kept; the newest batch is shown.
// Lives in MySQL so it survives deploys. Xero's API does not provide these figures.
const zlib = require('zlib');
const { getPool } = require('./mysqlPool');
const { buildShortCodeIndex } = require('../services/bankScreenReading');

let tableReady = null;
function ensureTables(pool = getPool()) {
  if (!tableReady) {
    tableReady = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS akrio_bank_screen_batches (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        org_id INT NOT NULL,
        short_code VARCHAR(16) NOT NULL,
        page_title VARCHAR(200) NULL,
        account_count SMALLINT NOT NULL,
        read_by_staff_id INT NULL,
        read_by_name VARCHAR(255) NULL,
        read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_bank_screen_batches_org (org_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS akrio_bank_screen_accounts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        batch_id BIGINT NOT NULL,
        org_id INT NOT NULL,
        position SMALLINT NOT NULL,
        account_name VARCHAR(255) NOT NULL,
        account_number VARCHAR(64) NULL,
        items_to_reconcile INT NULL,
        reconciled TINYINT(1) NOT NULL DEFAULT 0,
        balances_differ TINYINT(1) NOT NULL DEFAULT 0,
        balance_in_xero DECIMAL(16,2) NULL,
        statement_balance DECIMAL(16,2) NULL,
        statement_date_label VARCHAR(20) NULL,
        feed_problem TINYINT(1) NOT NULL DEFAULT 0,
        stopped_importing TINYINT(1) NOT NULL DEFAULT 0,
        no_feed TINYINT(1) NOT NULL DEFAULT 0,
        UNIQUE KEY uq_bank_screen_account (batch_id, position),
        KEY idx_bank_screen_accounts_org (org_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    })().catch(err => { tableReady = null; throw err; });
  }
  return tableReady;
}

const bit = value => (value ? 1 : 0);

// reading must already have been through validateReading. Batch and rows are written together or not at all.
async function saveReading(orgId, reading, staff = {}, { pool = getPool(), ensure = ensureTables } = {}) {
  if (!Number.isInteger(orgId)) throw new Error('saveReading needs the organisation id');
  await ensure(pool);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO akrio_bank_screen_batches (org_id, short_code, page_title, account_count, read_by_staff_id, read_by_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orgId, reading.shortCode, reading.pageTitle, reading.accounts.length, staff.id ?? null, staff.name ?? null]
    );
    const batchId = result.insertId;
    if (reading.accounts.length) {
      await connection.query(
        `INSERT INTO akrio_bank_screen_accounts (batch_id, org_id, position, account_name, account_number,
           items_to_reconcile, reconciled, balances_differ, balance_in_xero, statement_balance,
           statement_date_label, feed_problem, stopped_importing, no_feed) VALUES ?`,
        [reading.accounts.map((account, index) => [
          batchId, orgId, index, account.accountName, account.accountNumber, account.itemsToReconcile,
          bit(account.reconciled), bit(account.balancesDiffer), account.balanceInXero, account.statementBalance,
          account.statementDateLabel, bit(account.feedProblem), bit(account.stoppedImporting), bit(account.noFeed),
        ])]
      );
    }
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

async function getLatestReading(orgId, { pool = getPool(), ensure = ensureTables } = {}) {
  await ensure(pool);
  const [batches] = await pool.query(
    `SELECT id, short_code, page_title, account_count, read_by_name, UNIX_TIMESTAMP(read_at) AS read_at_unix
     FROM akrio_bank_screen_batches WHERE org_id = ? ORDER BY id DESC LIMIT 1`, [orgId]
  );
  if (!batches.length) return null;
  const batch = batches[0];
  const [rows] = await pool.query(
    `SELECT * FROM akrio_bank_screen_accounts WHERE batch_id = ? AND org_id = ? ORDER BY position`, [batch.id, orgId]
  );
  return {
    batchId: batch.id, pageTitle: batch.page_title, readByName: batch.read_by_name,
    // UNIX_TIMESTAMP gives the instant itself, so it does not depend on how the connection formats dates.
    readAt: new Date(Number(batch.read_at_unix) * 1000),
    accounts: rows.map(row => ({
      accountName: row.account_name, accountNumber: row.account_number,
      itemsToReconcile: row.items_to_reconcile == null ? null : Number(row.items_to_reconcile),
      reconciled: Boolean(row.reconciled), balancesDiffer: Boolean(row.balances_differ),
      balanceInXero: num(row.balance_in_xero), statementBalance: num(row.statement_balance),
      statementDateLabel: row.statement_date_label, feedProblem: Boolean(row.feed_problem),
      stoppedImporting: Boolean(row.stopped_importing), noFeed: Boolean(row.no_feed),
    })),
  };
}

// When each organisation was last read: Map(orgId -> Date). Used so an "update all" run can carry on where
// an interrupted one stopped instead of reading every client again.
async function getLastReadTimes({ pool = getPool(), ensure = ensureTables } = {}) {
  await ensure(pool);
  const [rows] = await pool.query(
    `SELECT org_id, UNIX_TIMESTAMP(MAX(read_at)) AS read_at_unix FROM akrio_bank_screen_batches GROUP BY org_id`
  );
  return new Map(rows.map(row => [Number(row.org_id), new Date(Number(row.read_at_unix) * 1000)]));
}

// How many active bank accounts the organisation has according to the data the nightly sync caches from
// Xero's API. Used to refuse a screen reading that shows none when Xero clearly has some.
async function getActiveBankAccountCount(orgId, { pool = getPool() } = {}) {
  const [rows] = await pool.query(`SELECT payload FROM akrio_xero_cache WHERE org_id = ? AND entity_type = 'account'`, [orgId]);
  let count = 0;
  for (const row of rows) {
    try {
      const account = JSON.parse(zlib.gunzipSync(row.payload).toString());
      if (account.type === 'BANK' && account.status === 'ACTIVE') count++;
    } catch (error) { /* unreadable record: not counted */ }
  }
  return count;
}

// Organisation -> Xero short code, from the organisation record each sync already caches. Kept in
// memory for ten minutes; a newly connected client appears after its first sync.
let indexCache = null;
async function getShortCodeIndex({ pool = getPool(), now = Date.now() } = {}) {
  if (indexCache && now - indexCache.at < 10 * 60 * 1000) return indexCache.index;
  const [rows] = await pool.query(`SELECT org_id, payload FROM akrio_xero_cache WHERE entity_type = 'organisation'`);
  const codes = [];
  for (const row of rows) {
    try {
      const organisation = JSON.parse(zlib.gunzipSync(row.payload).toString());
      codes.push({ orgId: Number(row.org_id), shortCode: organisation.shortCode });
    } catch (error) { /* an unreadable record simply has no short code */ }
  }
  const index = buildShortCodeIndex(codes);
  indexCache = { at: now, index };
  return index;
}

module.exports = { ensureTables, saveReading, getLatestReading, getLastReadTimes, getActiveBankAccountCount, getShortCodeIndex };
