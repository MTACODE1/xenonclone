const crypto = require('crypto');
const { RESERVED_PERIOD_LABELS, resolvePeriodChecked } = require('./checkRules');

const COLUMN_ALIASES = {
  date: ['date', 'transaction date', 'posted date', 'value date'],
  amount: ['amount', 'transaction amount', 'value'],
  debit: ['debit', 'money out', 'withdrawal', 'paid out'],
  credit: ['credit', 'money in', 'deposit', 'paid in'],
  reference: ['reference', 'ref', 'transaction reference'],
  description: ['description', 'details', 'narrative', 'memo', 'payee'],
};

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted && char === '"' && source[i + 1] === '"') {
      field += '"'; i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(field.trim()); field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field.trim());
  if (row.some(value => value !== '')) rows.push(row);
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  return rows;
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function detectColumnMapping(headers, overrides = {}) {
  const normalized = headers.map(normalizeHeader);
  const mapping = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    const override = String(overrides[key] || '').trim();
    const index = override
      ? normalized.indexOf(normalizeHeader(override))
      : normalized.findIndex(header => aliases.includes(header));
    if (index >= 0) mapping[key] = index;
  }
  if (mapping.date == null) throw new Error('Could not detect a date column');
  if (mapping.amount == null && (mapping.debit == null || mapping.credit == null)) {
    throw new Error('Provide an amount column or both debit and credit columns');
  }
  return mapping;
}

function parseAmount(value) {
  if (value == null || String(value).trim() === '') return 0;
  let cleaned = String(value).trim().replace(/[£,$\s]/g, '');
  const negative = /^\(.*\)$/.test(cleaned);
  cleaned = cleaned.replace(/[()]/g, '');
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) throw new Error(`Invalid amount "${value}"`);
  return negative ? -amount : amount;
}

function parseDate(value) {
  const raw = String(value || '').trim();
  let year, month, day;
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(raw)) {
    [year, month, day] = raw.slice(0, 10).split('-').map(Number);
  } else {
    const match = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/);
    if (!match) throw new Error(`Invalid date "${value}"`);
    [, day, month, year] = match.map(Number);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid date "${value}"`);
  }
  return date.toISOString().slice(0, 10);
}

function normalizeStatementLines(csvText, mappingOverrides = {}) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('CSV must contain a header and at least one transaction');
  const mapping = detectColumnMapping(rows[0], mappingOverrides);
  const lines = rows.slice(1).map((row, index) => {
    const amount = mapping.amount != null
      ? parseAmount(row[mapping.amount])
      : parseAmount(row[mapping.credit]) - Math.abs(parseAmount(row[mapping.debit]));
    return {
      lineNumber: index + 2,
      transactionDate: parseDate(row[mapping.date]),
      amount,
      reference: mapping.reference == null ? null : (row[mapping.reference] || null),
      description: mapping.description == null ? null : (row[mapping.description] || null),
    };
  });
  return {
    headers: rows[0],
    mapping: Object.fromEntries(Object.entries(mapping).map(([key, index]) => [key, rows[0][index]])),
    lines,
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function dayDistance(a, b) {
  return Math.abs(new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000;
}

function normalizeReference(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Bucket the candidate pool by bank account and amount-in-pence so a statement line does not have
// to scan every cached Xero record. The pool is now the client's whole bank history (needed so a
// statement from any period can be matched at all), which for the largest reference client is
// ~108k records — scanning that per line took ~4s for a 500-line statement, and the sync re-matches
// every stored statement. Neighbouring pence buckets are included so the exact sub-penny tolerance
// below is still the only thing that decides a match.
function indexCandidatePool(xeroItems) {
  const index = new Map();
  for (const item of xeroItems) {
    const key = `${item.bank_account_id}|${Math.round(Number(item.amount) * 100)}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(item); else index.set(key, [item]);
  }
  return index;
}

function poolCandidates(line, pool) {
  if (!(pool instanceof Map)) return pool;
  const pence = Math.round(Number(line.amount) * 100);
  const found = [];
  for (const offset of [-1, 0, 1]) {
    const bucket = pool.get(`${line.bankAccountId}|${pence + offset}`);
    if (bucket) found.push(...bucket);
  }
  return found;
}

// Candidate scoring shared by the single-line and allocating matchers. Same-date and
// reference agreement are the two signals a bank statement actually gives us; date distance
// breaks ties so the nearest posting wins rather than an arbitrary one.
function rankCandidates(line, xeroItems, dateWindowDays) {
  const candidates = poolCandidates(line, xeroItems).filter(item =>
    item.bank_account_id === line.bankAccountId &&
    Math.abs(Number(item.amount) - Number(line.amount)) < 0.01 &&
    item.transaction_date && dayDistance(item.transaction_date, line.transactionDate) <= dateWindowDays
  );
  const lineRef = normalizeReference(`${line.reference || ''} ${line.description || ''}`);
  return candidates.map(item => {
    const itemRef = normalizeReference(`${item.reference || ''} ${item.description || ''}`);
    const sameDate = item.transaction_date === line.transactionDate;
    const refMatch = !!lineRef && !!itemRef &&
      (lineRef === itemRef || lineRef.includes(itemRef) || itemRef.includes(lineRef));
    return {
      item,
      score: (sameDate ? 2 : 0) + (refMatch ? 2 : 0),
      sameDate,
      refMatch,
      distance: dayDistance(item.transaction_date, line.transactionDate),
    };
  }).sort((a, b) =>
    b.score - a.score ||
    a.distance - b.distance ||
    String(a.item.source_id || '').localeCompare(String(b.item.source_id || ''))
  );
}

function matchStatementLine(line, xeroItems, dateWindowDays = 3) {
  const ranked = rankCandidates(line, xeroItems, dateWindowDays);
  if (!ranked.length) return { confidence: 'unmatched', matchedId: null, candidates: 0 };
  const tied = ranked.filter(candidate =>
    candidate.score === ranked[0].score && candidate.distance === ranked[0].distance);
  if (tied.length > 1) return { confidence: 'ambiguous', matchedId: null, candidates: ranked.length };
  const best = ranked[0];
  return {
    confidence: best.sameDate && best.refMatch ? 'exact' : 'probable',
    matchedId: best.item.source_id,
    candidates: ranked.length,
  };
}

/**
 * Match a whole statement with GLOBAL ONE-TO-ONE allocation: one Xero record can explain at most
 * one statement line.
 *
 * Matching each line independently was the single largest source of false "processed" results.
 * Where a bank statement shows the same amount twice within the date window and Xero holds only
 * one such record — 610 same-account/date/amount payment groups exist on the reference clients,
 * carrying 1,564 surplus records — both lines previously matched that one record, so a genuinely
 * unprocessed item was reported as processed. Allocation is strongest-evidence-first, so the
 * confident claim keeps the record and the leftover line is correctly reported as unprocessed
 * rather than silently absorbed.
 */
function allocateStatementMatches(lines, xeroItems, dateWindowDays = 3) {
  const pool = indexCandidatePool(xeroItems);
  const ranked = lines.map((line, index) => ({
    index,
    line,
    candidates: rankCandidates(line, pool, dateWindowDays),
  }));

  // Every (line, candidate) pair, ordered so that the most defensible pairings are settled first.
  const pairs = [];
  for (const entry of ranked) {
    for (const candidate of entry.candidates) {
      pairs.push({ lineIndex: entry.index, candidate });
    }
  }
  pairs.sort((a, b) =>
    b.candidate.score - a.candidate.score ||
    a.candidate.distance - b.candidate.distance ||
    a.lineIndex - b.lineIndex ||
    String(a.candidate.item.source_id || '').localeCompare(String(b.candidate.item.source_id || ''))
  );

  const takenItems = new Set();
  const allocated = new Map();
  for (const pair of pairs) {
    if (allocated.has(pair.lineIndex)) continue;
    const itemId = pair.candidate.item.source_id;
    if (takenItems.has(itemId)) continue;
    takenItems.add(itemId);
    allocated.set(pair.lineIndex, pair.candidate);
  }

  return ranked.map(entry => {
    const chosen = allocated.get(entry.index);
    if (!chosen) {
      // Either nothing ever matched, or everything that matched was a better fit for another line.
      // Both mean no Xero record is left to represent this line, which is what "unprocessed" is.
      return {
        ...entry.line,
        confidence: 'unmatched',
        matchedId: null,
        candidates: entry.candidates.length,
      };
    }
    // A tie means the line is certainly processed but we cannot say by which record, so it stays
    // 'ambiguous' (still counted as processed) with no asserted id. The tie is judged against every
    // equally-ranked candidate, including ones another line ended up taking: if this line could
    // just as well have been paired with that record, the pairing we happened to make is arbitrary
    // and recording it as this line's matched record would be an unfounded claim.
    const equallyGood = entry.candidates.filter(candidate =>
      candidate.score === chosen.score && candidate.distance === chosen.distance
    );
    if (equallyGood.length > 1) {
      return {
        ...entry.line,
        confidence: 'ambiguous',
        matchedId: null,
        candidates: entry.candidates.length,
      };
    }
    return {
      ...entry.line,
      confidence: chosen.sameDate && chosen.refMatch ? 'exact' : 'probable',
      matchedId: chosen.item.source_id,
      candidates: entry.candidates.length,
    };
  });
}

function matchStatementLines(lines, xeroItems, bankAccountId) {
  return allocateStatementMatches(
    lines.map(line => ({ ...line, bankAccountId })),
    xeroItems
  );
}

function balanceDiscrepancy(statementBalance, xeroBalance) {
  if (statementBalance == null || xeroBalance == null) return null;
  if (!Number.isFinite(Number(statementBalance)) || !Number.isFinite(Number(xeroBalance))) return null;
  return Math.abs(Number(statementBalance) - Number(xeroBalance));
}

// Statutory accounts are filed to the nearest pound, so a filed figure carrying no pence cannot be
// held to penny precision against Xero: 4X4 (£0.25), Handymanz (£0.12) and Rose (£0.99) were each
// reported as an opening-balance difference that is purely the filing's own rounding, and Xenon
// reports all three as clean. MBX's genuine £114,390 difference is unaffected by a £1 tolerance.
function filedRoundingTolerance(filedNetAssets) {
  return Number.isInteger(Number(filedNetAssets)) ? 1 : 0.01;
}

function filedAccountsComparison(filedNetAssets, xeroNetAssets, tolerance = null) {
  if (xeroNetAssets == null) return { configured: false, difference: null, hasIssue: null };
  if (!Number.isFinite(Number(xeroNetAssets))) return { configured: false, difference: null, hasIssue: null };
  const difference = Math.abs(Number(filedNetAssets) - Number(xeroNetAssets));
  const limit = tolerance == null ? filedRoundingTolerance(filedNetAssets) : tolerance;
  return { configured: true, difference, hasIssue: difference > limit };
}

// The balance-sheet row label is normalised before matching so that the common
// "Net Assets/(Liabilities)" rendering is recognised. Normalisation only strips a trailing
// liabilities qualifier, so "Total Equity and Liabilities" — a different figure entirely — still
// does not match the anchored pattern below.
function normaliseBalanceSheetLabel(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/:$/, '')
    .replace(/\s*\/\s*\(?net liabilities\)?$/, '')
    .replace(/\s*\/\s*\(?liabilities\)?$/, '')
    .replace(/\s*\(net liabilities\)$/, '')
    .replace(/\s*\(liabilities\)$/, '');
}

const NET_ASSETS_ROW_LABEL = /^(net assets|net liabilities|total equity)$/;

// Report cells are strings. A negative position may arrive as "-1234.56" or as "(1,234.56)"; the
// bracketed form previously parsed to NaN and was discarded, which left the check permanently on
// "needs sync" for exactly the clients that most need it — a net-liability balance sheet.
function parseBalanceSheetNumber(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[()£,\s]/g, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return negative ? -Math.abs(value) : value;
}

function extractNetAssetsFromBalanceSheet(report) {
  const rows = [];
  const visit = value => {
    if (!value) return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== 'object') return;
    if (value.cells) rows.push(value);
    visit(value.rows);
  };
  visit(report?.rows || []);
  const row = rows.find(candidate =>
    NET_ASSETS_ROW_LABEL.test(normaliseBalanceSheetLabel(candidate.cells?.[0]?.value)));
  if (!row) return null;
  // Asked for a date the organisation has no bookkeeping at, Xero answers with a balance sheet
  // carrying a single zero "Net Assets" line and no sections at all. That zero means "nothing is
  // recorded here", not "net assets are nil", so treating it as a figure invents an opening-balance
  // difference equal to the entire filed net assets. A balance sheet holding real bookkeeping
  // always carries a non-zero figure somewhere, even when net assets themselves net to zero.
  const holdsBookkeeping = rows.some(candidate => (candidate.cells || []).slice(1).some(cell => {
    const value = parseBalanceSheetNumber(cell.value);
    return value != null && value !== 0;
  }));
  if (!holdsBookkeeping) return null;
  const values = row.cells.slice(1)
    .map(cell => parseBalanceSheetNumber(cell.value))
    .filter(value => value != null);
  return values.length ? values[0] : null;
}

function evidenceFreshness(date, now = new Date()) {
  if (!date) return 'unknown';
  return dayDistance(date, now.toISOString().slice(0, 10)) > 35 ? 'stale' : 'current';
}

function recomputeEvidenceIssues(orgId, periodKey = null, onlyCheck = null, options = {}) {
  const {
    getBankReconciliationForOrg, getFiledAccountsForOrg, getLatestStatementImportsForOrg,
    getLatestStatementLinesForOrg, getIssueByCheckType, refreshLatestHealthScore, replaceIssueForCheck,
  } = require('../db/queries');
  // A reserved label (not_configured/needs_sync/...) is not a real period range, so it must never
  // stand in for one here — falling back to it would then get written onto a DIFFERENT check's
  // genuine period_checked below (e.g. bank_balance correctly stored as 'not_configured' could
  // otherwise leak into opening_balance_differences's real 'filed_accounts_2025-10-31' label the
  // next time this function is called without an explicit periodKey).
  const effectivePeriodKey = periodKey || [
    getIssueByCheckType(orgId, 'bank_balance')?.period_checked,
    getIssueByCheckType(orgId, 'unprocessed_bank')?.period_checked,
  ].find(value => value && !RESERVED_PERIOD_LABELS.has(value)) || null;
  const imports = getLatestStatementImportsForOrg(orgId);
  const lines = getLatestStatementLinesForOrg(orgId);
  const unmatched = lines.filter(line => line.match_confidence === 'unmatched').map(line => ({
    statementLineId: line.id, accountId: line.bank_account_id, account: line.bank_account_name,
    date: line.transaction_date, amount: line.amount, reference: line.reference,
    description: line.description, confidence: line.match_confidence,
    evidenceDate: line.statement_end_date, evidenceFreshness: evidenceFreshness(line.statement_end_date),
  }));
  const replace = data => {
    if (onlyCheck && data.check_type !== onlyCheck) return;
    replaceIssueForCheck({
      ...data,
      // Same rule as xeroSync.js's persistIssue: a check's own not_configured/needs_sync label
      // survives instead of being unconditionally replaced by effectivePeriodKey.
      period_checked: resolvePeriodChecked(data.period_checked, effectivePeriodKey),
      run_id: options.runId || null,
      is_active: options.isActive == null ? 1 : options.isActive,
    });
  };
  replace({
    org_id: orgId, check_type: 'unprocessed_bank', importance: 'critical',
    count: imports.length ? unmatched.length : null,
    potential_value_gbp: unmatched.reduce((sum, line) => sum + Math.abs(line.amount), 0),
    detail_json: JSON.stringify(unmatched),
    period_checked: imports.length
      ? `imported_statements_${imports.map(item => item.statement_end_date).sort().pop()}`
      : 'not_configured',
  });

  const reconciliation = getBankReconciliationForOrg(orgId);
  const byAccount = new Map(reconciliation.map(account => [account.bank_account_id, account]));
  const importedAccounts = new Set(imports.map(item => item.bank_account_id));
  const evidence = imports.map(item => {
    const xero = byAccount.get(item.bank_account_id);
    return {
      accountId: item.bank_account_id, name: item.bank_account_name,
      statementBalance: item.closing_balance, statementDate: item.statement_end_date,
      evidenceSource: 'CSV statement', evidenceFreshness: evidenceFreshness(item.statement_end_date),
      xeroBalance: xero?.xero_calculated_balance ?? null, xeroBalanceAsOf: xero?.xero_balance_as_of ?? null,
    };
  });
  for (const account of reconciliation) {
    if (importedAccounts.has(account.bank_account_id) || account.statement_balance == null) continue;
    evidence.push({
      accountId: account.bank_account_id, name: account.bank_account_name,
      statementBalance: account.statement_balance,
      statementDate: account.statement_balance_updated_at?.slice(0, 10) || null,
      evidenceSource: 'Manual closing balance',
      evidenceFreshness: evidenceFreshness(account.statement_balance_updated_at?.slice(0, 10)),
      xeroBalance: account.xero_calculated_balance, xeroBalanceAsOf: account.xero_balance_as_of,
    });
  }
  const comparable = evidence.filter(item => Number.isFinite(Number(item.xeroBalance)));
  const discrepancies = comparable.map(item => ({
    ...item, discrepancy: balanceDiscrepancy(item.statementBalance, item.xeroBalance),
  })).filter(item => item.discrepancy > 0.01);
  replace({
    org_id: orgId, check_type: 'bank_balance', importance: 'critical',
    count: discrepancies.length
      ? discrepancies.length
      : evidence.length && comparable.length === evidence.length ? 0 : null,
    potential_value_gbp: discrepancies.reduce((sum, item) => sum + item.discrepancy, 0),
    detail_json: JSON.stringify(discrepancies),
    period_checked: !evidence.length ? 'not_configured'
      : comparable.length !== evidence.length ? 'needs_sync'
        : `statement_comparison_as_of_${evidence.map(item => item.statementDate).filter(Boolean).sort().pop()}`,
  });

  const filed = getFiledAccountsForOrg(orgId)[0];
  const comparison = filed ? filedAccountsComparison(filed.net_assets, filed.xero_net_assets) : null;
  const filedDetails = comparison?.configured ? [{
    filingDate: filed.filing_date, filedNetAssets: filed.net_assets,
    xeroNetAssets: filed.xero_net_assets, xeroBalanceAsOf: filed.xero_balance_as_of,
    difference: comparison.difference, sourceNote: filed.source_note,
  }].filter(() => comparison.hasIssue) : [];
  replace({
    org_id: orgId, check_type: 'opening_balance_differences', importance: 'high',
    count: !filed || !comparison.configured ? null : filedDetails.length,
    potential_value_gbp: filedDetails.reduce((sum, item) => sum + item.difference, 0),
    detail_json: JSON.stringify(filedDetails),
    // A sync that ran and found no bookkeeping at the filing date is a permanent answer, not a
    // pending one: telling the practice to "sync" again would never change it.
    period_checked: !filed ? 'not_configured'
      : comparison.configured ? `filed_accounts_${filed.filing_date}`
        : filed.xero_synced_at ? 'unavailable' : 'needs_sync',
  });
  if (!options.deferScoreRefresh) refreshLatestHealthScore(orgId);
}

module.exports = {
  allocateStatementMatches, balanceDiscrepancy, detectColumnMapping,
  extractNetAssetsFromBalanceSheet,
  filedAccountsComparison, matchStatementLine, matchStatementLines,
  normalizeStatementLines, parseCsv, recomputeEvidenceIssues, sha256,
};
