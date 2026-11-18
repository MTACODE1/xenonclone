// One row per bank-transaction LINE with the chart-of-accounts account the bookkeeper coded it to, plus the
// reconciliation adjustments Xero keeps only in the ledger (see reconciliationAdjustmentsToLines).
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

// ---- Reconciliation adjustments ----
// When a bookkeeper reconciles a statement line against a bill or invoice for a slightly different amount and accepts
// the difference, Xero posts it straight to the general ledger: the bank account against the ROUNDING system account.
// Xero's bank account screen lists it as "Reconciliation adjustment", but neither BankTransactions nor Payments returns
// it (Novahomes, 18 Nov 2026: 29 of 2,417 processed entries). It is in the Journals the sync already holds, as a journal
// with no source document. Those are turned into rows here so the bank list matches the bank account in Xero.
const ADJUSTMENT_TYPE = 'RECON ADJUSTMENT';
const isBlank = value => value == null || String(value).trim() === '';
const amountOf = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};
// Whole pence, rounding away from zero on both sides so +x and -x always cancel (Math.round alone sends -0.125 to
// -0.12 and +0.125 to +0.13).
const toCents = n => Math.sign(n) * Math.round(Math.abs(n) * 100);
const negated = n => { const cents = -toCents(n); return cents === 0 ? 0 : cents / 100; };   // never -0
// A real calendar date in YYYY-MM-DD: MySQL rejects anything else, and one bad row would roll back the whole batch.
const isRealDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

// Pure: cached Xero journals + chart of accounts -> table rows. Money out is negative, as for bank transactions.
// Only a journal with no source, exactly one bank account and every other line on the ROUNDING account qualifies;
// other ledger-only journals that touch a bank account (conversion balances, revaluations) are not cash movements.
function reconciliationAdjustmentsToLines(orgId, journals, accounts, baseCurrency = null) {
  const byId = new Map();
  const byCode = new Map();
  const ambiguousCodes = new Set();
  for (const account of accounts || []) {
    if (!account) continue;
    if (!isBlank(account.accountID)) byId.set(String(account.accountID).toLowerCase(), account);
    if (!isBlank(account.code)) {
      const key = String(account.code).toLowerCase();
      if (byCode.has(key)) ambiguousCodes.add(key); else byCode.set(key, account);
    }
  }
  // An explicit account ID that is not in the chart is never replaced by a code match.
  const resolve = line => {
    if (!isBlank(line?.accountID)) return byId.get(String(line.accountID).toLowerCase()) || null;
    if (isBlank(line?.accountCode)) return null;
    const key = String(line.accountCode).toLowerCase();
    return ambiguousCodes.has(key) ? null : (byCode.get(key) || null);
  };

  const candidates = [];
  for (const journal of journals || []) {
    if (!journal || isBlank(journal.journalID) || !isBlank(journal.sourceType) || !isBlank(journal.sourceID)) continue;
    const date = toDateString(journal.journalDate);
    if (!isRealDate(date)) continue;
    const resolved = (journal.journalLines || []).map(line => ({ line, account: resolve(line) }));
    if (!resolved.length || resolved.some(item => !item.account)) continue;
    const bankLines = resolved.filter(item => item.account.type === 'BANK');
    const others = resolved.filter(item => item.account.type !== 'BANK');
    if (!bankLines.length || !others.length) continue;
    if (new Set(bankLines.map(item => item.account)).size !== 1) continue;
    if (others.some(item => item.account.systemAccount !== 'ROUNDING')) continue;
    const amounts = others.map(item => ({
      net: amountOf(item.line.netAmount), tax: amountOf(item.line.taxAmount ?? 0), gross: amountOf(item.line.grossAmount),
    }));
    if (amounts.some(a => a.net == null || a.tax == null || a.gross == null)) continue;
    candidates.push({
      journal, date, bank: bankLines[0], others, amounts,
      cents: amounts.reduce((sum, a) => sum + toCents(a.net), 0),
      number: Number(journal.journalNumber) || 0,
    });
  }

  // Undoing an adjustment makes Xero post the opposite journal on the same date, and its bank account screen then shows
  // neither. Both rows are kept (nothing is deleted, the net is unchanged) but marked, so the live ones match Xero.
  // Xero gives no link between the two, so only an exact same-date, same-accounts, opposite-amount pair is marked,
  // pairing in posting order; a later re-entry of the same amount stays live.
  const open = new Map();
  const reversed = new Set();
  for (const item of [...candidates].sort((a, b) => a.number - b.number)) {
    if (item.cents === 0) continue;
    const scope = `${item.date}|${item.bank.account.accountID || item.bank.account.code}|${item.others.map(o => o.account.accountID || o.account.code).sort().join(',')}`;
    const waiting = open.get(`${scope}|${-item.cents}`);
    if (waiting?.length) {
      reversed.add(waiting.shift()); reversed.add(item);
    } else {
      const key = `${scope}|${item.cents}`;
      if (!open.has(key)) open.set(key, []);
      open.get(key).push(item);
    }
  }

  const currency = typeof baseCurrency === 'string' && /^[A-Z]{3}$/.test(baseCurrency) ? baseCurrency : null;
  const rows = [];
  for (const item of candidates) {
    const isReversed = reversed.has(item);
    item.others.forEach(({ line, account }, index) => {
      const amount = item.amounts[index];
      rows.push([
        orgId, String(item.journal.journalID), index, item.date, ADJUSTMENT_TYPE, isReversed ? 'REVERSED' : 'AUTHORISED',
        1, null, clip(item.journal.reference, 255),
        clip(item.bank.line.accountName || item.bank.account.name, 255),
        clip(line.accountCode ?? account.code, 32), clip(line.accountName || account.name, 255),
        clip(line.accountType || account.type, 32),
        isReversed ? 'Reconciliation adjustment (reversed)' : 'Reconciliation adjustment', clip(line.taxType, 40),
        negated(amount.net), negated(amount.tax), negated(amount.gross), currency, null,
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

// Rewrites the rows of every adjustment passed in, in one transaction, so a pair is never half-saved. Only rows this
// module built are accepted, the delete is scoped to adjustment rows, and ids absent from the batch are left alone.
async function saveReconciliationAdjustmentLines(orgId, rows, { pool, ensure } = {}) {
  if (!rows?.length) return 0;
  if (rows.some(row => row[0] !== orgId)) throw new Error('Reconciliation adjustment rows belong to another organisation');
  if (rows.some(row => row[4] !== ADJUSTMENT_TYPE)) throw new Error('Only reconciliation adjustment rows can be saved here');
  if (!pool && !process.env.AKRIO_DB_USER) return 0;
  await (ensure || ensureTable)();
  const ids = [...new Set(rows.map(row => row[1]))];
  const conn = await (pool || getPool()).getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const wanted = new Set(chunk);
      await conn.query('DELETE FROM akrio_bank_lines WHERE org_id = ? AND txn_type = ? AND bank_transaction_id IN (?)',
        [orgId, ADJUSTMENT_TYPE, chunk]);
      await conn.query(`INSERT INTO akrio_bank_lines (${COLUMNS.join(',')}) VALUES ?`,
        [rows.filter(row => wanted.has(row[1]))]);
    }
    await conn.commit();
    return rows.length;
  } catch (err) {
    await Promise.resolve(conn.rollback()).catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
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
  reconciliationAdjustmentsToLines, saveReconciliationAdjustmentLines, ADJUSTMENT_TYPE,
};
