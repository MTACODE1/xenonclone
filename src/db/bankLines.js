// One row per bank-transaction LINE with the chart-of-accounts account the bookkeeper coded it to.
// Lives in MySQL (not the container's SQLite) so it survives deploys, and is filled from the bank
// transactions the sync already downloads, so it costs no extra Xero calls.
const { getPool } = require('./mysqlPool');
const { toDateString } = require('../services/checkRules');

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = getPool().query(`CREATE TABLE IF NOT EXISTS akrio_bank_lines (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      org_id INT NOT NULL,
      bank_transaction_id CHAR(36) NOT NULL,
      line_no SMALLINT NOT NULL,
      txn_date DATE NULL,
      txn_type VARCHAR(24) NULL,
      status VARCHAR(16) NULL,
      is_reconciled TINYINT(1) NOT NULL DEFAULT 0,
      contact_name VARCHAR(255) NULL,
      reference VARCHAR(255) NULL,
      bank_account_name VARCHAR(255) NULL,
      account_code VARCHAR(32) NULL,
      account_name VARCHAR(255) NULL,
      account_type VARCHAR(32) NULL,
      description VARCHAR(1000) NULL,
      tax_type VARCHAR(40) NULL,
      net DECIMAL(16,2) NULL,
      tax DECIMAL(16,2) NULL,
      gross DECIMAL(16,2) NULL,
      currency CHAR(3) NULL,
      updated_at_xero DATETIME NULL,
      synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_bank_line (org_id, bank_transaction_id, line_no),
      KEY idx_bank_lines_date (org_id, txn_date),
      KEY idx_bank_lines_account (org_id, account_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`).catch(err => { tableReady = null; throw err; });
  }
  return tableReady;
}

const clip = (value, max) => (value == null ? null : String(value).slice(0, max));
const round2 = n => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

// Pure: Xero bank transactions -> table rows. Money out is negative, matching the Excel export.
function bankTransactionsToLines(orgId, transactions, accountsByCode = {}) {
  const rows = [];
  for (const txn of transactions || []) {
    if (!txn?.bankTransactionID) continue;
    const type = txn.type || '';
    const isTransfer = type.includes('TRANSFER');
    const sign = type.startsWith('SPEND') && !isTransfer ? -1 : 1;
    const lines = txn.lineItems?.length ? txn.lineItems : [{}];
    lines.forEach((line, index) => {
      const code = line.accountCode ? String(line.accountCode) : null;
      const account = code ? accountsByCode[code] : null;
      const tax = Number(line.taxAmount) || 0;
      const hasAmount = line.lineAmount != null && Number.isFinite(Number(line.lineAmount));
      const lineAmount = hasAmount ? Number(line.lineAmount) : null;
      const net = hasAmount ? (txn.lineAmountTypes === 'Inclusive' ? lineAmount - tax : lineAmount) : null;
      rows.push([
        orgId, txn.bankTransactionID, index, toDateString(txn.date), clip(type, 24), clip(txn.status, 16),
        txn.isReconciled ? 1 : 0, clip(txn.contact?.name, 255), clip(txn.reference, 255),
        clip(txn.bankAccount?.name, 255), clip(code, 32), clip(account?.name, 255), clip(account?.type, 32),
        clip(line.description, 1000), clip(line.taxType, 40),
        hasAmount ? round2(sign * net) : null, hasAmount ? round2(sign * tax) : null,
        hasAmount ? round2(sign * (net + tax)) : null,
        clip(txn.currencyCode, 3),
        txn.updatedDateUTC ? (toDateString(txn.updatedDateUTC) || null) : null,
      ]);
    });
  }
  return rows;
}

const COLUMNS = ['org_id', 'bank_transaction_id', 'line_no', 'txn_date', 'txn_type', 'status', 'is_reconciled',
  'contact_name', 'reference', 'bank_account_name', 'account_code', 'account_name', 'account_type', 'description',
  'tax_type', 'net', 'tax', 'gross', 'currency', 'updated_at_xero'];

// Rewrites the lines of every transaction passed in (so a transaction that lost a line in Xero does
// not keep a stale row). Never deletes transactions that are merely absent from the batch: an empty
// or partial cache must not be able to wipe stored history.
async function saveBankLines(orgId, transactions, accountsByCode) {
  if (!process.env.AKRIO_DB_USER || !transactions?.length) return 0;
  await ensureTable();
  const pool = getPool();
  let saved = 0;
  for (let i = 0; i < transactions.length; i += 200) {
    const chunk = transactions.slice(i, i + 200);
    const rows = bankTransactionsToLines(orgId, chunk, accountsByCode);
    if (!rows.length) continue;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM akrio_bank_lines WHERE org_id = ? AND bank_transaction_id IN (?)',
        [orgId, chunk.map(t => t.bankTransactionID).filter(Boolean)]);
      await conn.query(`INSERT INTO akrio_bank_lines (${COLUMNS.join(',')}) VALUES ?`, [rows]);
      await conn.commit();
      saved += rows.length;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }
  return saved;
}

function buildWhere(filters = {}) {
  const where = [];
  const params = [];
  if (Array.isArray(filters.orgIds)) {
    if (!filters.orgIds.length) return { sql: '1 = 0', params: [] };
    where.push('l.org_id IN (?)'); params.push(filters.orgIds);
  }
  if (filters.from) { where.push('l.txn_date >= ?'); params.push(filters.from); }
  if (filters.to) { where.push('l.txn_date <= ?'); params.push(filters.to); }
  if (filters.accountCode) { where.push('l.account_code = ?'); params.push(filters.accountCode); }
  if (filters.reconciled === 'yes') where.push('l.is_reconciled = 1');
  if (filters.reconciled === 'no') where.push('l.is_reconciled = 0');
  if (filters.status) { where.push('l.status = ?'); params.push(filters.status); }
  if (filters.search) {
    const like = `%${filters.search}%`;
    where.push('(l.contact_name LIKE ? OR l.description LIKE ? OR l.reference LIKE ? OR l.account_name LIKE ?)');
    params.push(like, like, like, like);
  }
  return { sql: where.length ? where.join(' AND ') : '1 = 1', params };
}

const SELECT = `SELECT l.*, o.name AS client_name FROM akrio_bank_lines l
  JOIN akrio_organisations o ON o.id = l.org_id`;

async function listBankLines(filters = {}, { limit = 200, offset = 0 } = {}) {
  await ensureTable();
  const { sql, params } = buildWhere(filters);
  const [rows] = await getPool().query(
    `${SELECT} WHERE ${sql} ORDER BY l.txn_date DESC, l.org_id, l.bank_transaction_id, l.line_no LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [[{ total }]] = await getPool().query(`SELECT COUNT(*) AS total FROM akrio_bank_lines l WHERE ${sql}`, params);
  return { rows, total };
}

// Streams through the whole filtered set in pages so a full export never holds it all in memory.
async function eachBankLinePage(filters, pageSize, onPage) {
  await ensureTable();
  const { sql, params } = buildWhere(filters);
  let lastId = 0;
  for (;;) {
    const [rows] = await getPool().query(
      `${SELECT} WHERE ${sql} AND l.id > ? ORDER BY l.id LIMIT ?`, [...params, lastId, pageSize]
    );
    if (!rows.length) break;
    await onPage(rows);
    lastId = rows[rows.length - 1].id;
    if (rows.length < pageSize) break;
  }
}

async function bankLineAccountSummary(filters = {}) {
  await ensureTable();
  const { sql, params } = buildWhere(filters);
  const [rows] = await getPool().query(
    `SELECT l.account_code, MAX(l.account_name) AS account_name, MAX(l.account_type) AS account_type,
            COUNT(*) AS line_count, SUM(l.gross) AS gross
       FROM akrio_bank_lines l WHERE ${sql}
      GROUP BY l.account_code ORDER BY (l.account_code IS NULL), l.account_code`, params
  );
  return rows;
}

module.exports = {
  bankTransactionsToLines, saveBankLines, listBankLines, eachBankLinePage, bankLineAccountSummary, ensureTable,
};
