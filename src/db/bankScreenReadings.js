// Readings of Xero's "Bank accounts" page taken by the Akrio Verify browser extension. One batch per
// read of one organisation, one row per bank account in it. History is kept; the newest batch is shown.
// Lives in MySQL so it survives deploys. Xero's API does not provide these figures.
const zlib = require('zlib');
const { getPool } = require('./mysqlPool');
const { buildShortCodeIndex } = require('../services/bankScreenReading');
const { ukStatementLabel } = require('../services/displayDate');

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
      // The "items to reconcile" lists: one read per bank account (the newest replaces the one before), one
      // row per unreconciled statement line.
      await pool.query(`CREATE TABLE IF NOT EXISTS akrio_bank_screen_line_reads (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        org_id INT NOT NULL,
        account_name VARCHAR(255) NOT NULL,
        line_count INT NOT NULL,
        line_value DECIMAL(16,2) NOT NULL DEFAULT 0,
        oldest_date DATE NULL,
        truncated TINYINT(1) NOT NULL DEFAULT 0,
        total_shown INT NULL,
        read_by_staff_id INT NULL,
        read_by_name VARCHAR(255) NULL,
        read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_bank_screen_line_reads_org (org_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS akrio_bank_screen_lines (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        read_id BIGINT NOT NULL,
        org_id INT NOT NULL,
        position INT NOT NULL,
        line_date DATE NOT NULL,
        line_type VARCHAR(40) NULL,
        payee VARCHAR(255) NULL,
        particulars VARCHAR(500) NULL,
        code VARCHAR(100) NULL,
        reference VARCHAR(255) NULL,
        spent DECIMAL(16,2) NULL,
        received DECIMAL(16,2) NULL,
        source VARCHAR(60) NULL,
        UNIQUE KEY uq_bank_screen_line (read_id, position),
        KEY idx_bank_screen_lines_org (org_id)
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

// lines must already have been through validateLines. The account's earlier read is replaced; all or nothing.
async function saveLines(orgId, read, staff = {}, { pool = getPool(), ensure = ensureTables } = {}) {
  if (!Number.isInteger(orgId)) throw new Error('saveLines needs the organisation id');
  await ensure(pool);
  const { summariseLines } = require('../services/bankScreenReading');
  const summary = summariseLines(read.lines);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [old] = await connection.query(
      `SELECT id FROM akrio_bank_screen_line_reads WHERE org_id = ? AND account_name = ?`, [orgId, read.accountName]);
    if (old.length) {
      const ids = old.map(row => row.id);
      await connection.query(`DELETE FROM akrio_bank_screen_lines WHERE read_id IN (?) AND org_id = ?`, [ids, orgId]);
      await connection.query(`DELETE FROM akrio_bank_screen_line_reads WHERE id IN (?) AND org_id = ?`, [ids, orgId]);
    }
    const [result] = await connection.query(
      `INSERT INTO akrio_bank_screen_line_reads (org_id, account_name, line_count, line_value, oldest_date, truncated,
         total_shown, read_by_staff_id, read_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, read.accountName, read.lines.length, summary.value, summary.oldest, bit(read.truncated),
        read.totalShownByXero, staff.id ?? null, staff.name ?? null]
    );
    const readId = result.insertId;
    for (let start = 0; start < read.lines.length; start += 200) {
      await connection.query(
        `INSERT INTO akrio_bank_screen_lines (read_id, org_id, position, line_date, line_type, payee, particulars, code,
           reference, spent, received, source) VALUES ?`,
        [read.lines.slice(start, start + 200).map((line, index) => [
          readId, orgId, start + index, line.date, line.type, line.payee, line.particulars, line.code,
          line.reference, line.spent, line.received, line.source,
        ])]
      );
    }
    await connection.commit();
    return readId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

const isoDay = value => (value == null ? null : (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)));

// The newest read of each bank account of one organisation, without the lines: name, how many lines, their
// value, the oldest date and when it was read. Used by the Unprocessed Bank check.
async function getLineSummaries(orgId, { pool = getPool(), ensure = ensureTables } = {}) {
  await ensure(pool);
  const [rows] = await pool.query(
    `SELECT account_name, line_count, line_value, DATE_FORMAT(oldest_date, '%Y-%m-%d') AS oldest_date, truncated,
       total_shown, read_by_name, UNIX_TIMESTAMP(read_at) AS read_at_unix
     FROM akrio_bank_screen_line_reads WHERE org_id = ? ORDER BY id`, [orgId]
  );
  const byAccount = new Map();
  for (const row of rows) {
    byAccount.set(row.account_name, {
      accountName: row.account_name, lineCount: Number(row.line_count), value: Number(row.line_value),
      oldest: row.oldest_date || null, truncated: Boolean(row.truncated),
      totalShownByXero: row.total_shown == null ? null : Number(row.total_shown),
      readByName: row.read_by_name, readAt: new Date(Number(row.read_at_unix) * 1000),
    });
  }
  return [...byAccount.values()];
}

// The stored lines of one bank account (newest read), or null.
async function getStoredLines(orgId, accountName, { pool = getPool(), ensure = ensureTables } = {}) {
  await ensure(pool);
  const [reads] = await pool.query(
    `SELECT id, line_count, truncated, total_shown, read_by_name, UNIX_TIMESTAMP(read_at) AS read_at_unix
     FROM akrio_bank_screen_line_reads WHERE org_id = ? AND account_name = ? ORDER BY id DESC LIMIT 1`, [orgId, accountName]
  );
  if (!reads.length) return null;
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(line_date, '%Y-%m-%d') AS line_date, line_type, payee, particulars, code, reference, spent, received, source
     FROM akrio_bank_screen_lines WHERE read_id = ? AND org_id = ? ORDER BY position`, [reads[0].id, orgId]
  );
  return {
    accountName, truncated: Boolean(reads[0].truncated),
    totalShownByXero: reads[0].total_shown == null ? null : Number(reads[0].total_shown),
    readByName: reads[0].read_by_name, readAt: new Date(Number(reads[0].read_at_unix) * 1000),
    lines: rows.map(row => ({
      date: isoDay(row.line_date), type: row.line_type, payee: row.payee, particulars: row.particulars, code: row.code,
      reference: row.reference, spent: num(row.spent), received: num(row.received), source: row.source,
    })),
  };
}

// For the all-clients Transactions page: each organisation's items to reconcile in its newest reading.
// Map(orgId -> { items, accounts, readAt }).
async function getLatestItemTotals({ pool = getPool(), ensure = ensureTables } = {}) {
  await ensure(pool);
  const [rows] = await pool.query(
    `SELECT b.org_id, UNIX_TIMESTAMP(b.read_at) AS read_at_unix, COALESCE(SUM(a.items_to_reconcile), 0) AS items,
       SUM(a.items_to_reconcile > 0) AS accounts
     FROM akrio_bank_screen_batches b
     JOIN (SELECT org_id, MAX(id) AS id FROM akrio_bank_screen_batches GROUP BY org_id) latest ON latest.id = b.id
     LEFT JOIN akrio_bank_screen_accounts a ON a.batch_id = b.id AND a.org_id = b.org_id
     GROUP BY b.org_id, b.read_at`
  );
  return new Map(rows.map(row => [Number(row.org_id), {
    items: Number(row.items) || 0, accounts: Number(row.accounts) || 0, readAt: new Date(Number(row.read_at_unix) * 1000),
  }]));
}

// For Client Panorama: every organisation's newest reading (accounts with items to reconcile) and the newest list
// of lines of each of its bank accounts, as counts per date. Map(orgId -> { reading, lineReads }).
async function getUnprocessedByDate({ pool = getPool(), ensure = ensureTables } = {}) {
  await ensure(pool);
  const [accounts] = await pool.query(
    `SELECT b.org_id, UNIX_TIMESTAMP(b.read_at) AS read_at_unix, a.account_name, a.items_to_reconcile
     FROM akrio_bank_screen_batches b
     JOIN (SELECT org_id, MAX(id) AS id FROM akrio_bank_screen_batches GROUP BY org_id) latest ON latest.id = b.id
     LEFT JOIN akrio_bank_screen_accounts a ON a.batch_id = b.id AND a.org_id = b.org_id`
  );
  const [reads] = await pool.query(
    `SELECT r.id, r.org_id, r.account_name, r.truncated, UNIX_TIMESTAMP(r.read_at) AS read_at_unix
     FROM akrio_bank_screen_line_reads r
     JOIN (SELECT org_id, account_name, MAX(id) AS id FROM akrio_bank_screen_line_reads GROUP BY org_id, account_name) newest
       ON newest.id = r.id`
  );
  const [days] = await pool.query(
    `SELECT read_id, DATE_FORMAT(line_date, '%Y-%m-%d') AS line_day, COUNT(*) AS line_total
     FROM akrio_bank_screen_lines GROUP BY read_id, line_date`
  );
  const daysByRead = new Map();
  for (const row of days) {
    if (!daysByRead.has(Number(row.read_id))) daysByRead.set(Number(row.read_id), new Map());
    daysByRead.get(Number(row.read_id)).set(row.line_day, Number(row.line_total));
  }
  const byOrg = new Map();
  const entry = orgId => {
    if (!byOrg.has(orgId)) byOrg.set(orgId, { reading: { readAt: null, accounts: [] }, lineReads: [] });
    return byOrg.get(orgId);
  };
  for (const row of accounts) {
    const item = entry(Number(row.org_id));
    item.reading.readAt = new Date(Number(row.read_at_unix) * 1000);
    if (row.account_name != null) {
      item.reading.accounts.push({ accountName: row.account_name, itemsToReconcile: row.items_to_reconcile == null ? null : Number(row.items_to_reconcile) });
    }
  }
  for (const row of reads) {
    entry(Number(row.org_id)).lineReads.push({
      accountName: row.account_name, truncated: Boolean(row.truncated),
      readAt: new Date(Number(row.read_at_unix) * 1000), days: daysByRead.get(Number(row.id)) || new Map(),
    });
  }
  return byOrg;
}

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
      // Xero's own label ("Nov 17") shown day first ("17 Nov"); the stored reading is unchanged.
      statementDateLabel: ukStatementLabel(row.statement_date_label), feedProblem: Boolean(row.feed_problem),
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

module.exports = {
  ensureTables, saveReading, getLatestReading, getLastReadTimes, getActiveBankAccountCount, getShortCodeIndex,
  saveLines, getLineSummaries, getStoredLines, getLatestItemTotals, getUnprocessedByDate,
};
