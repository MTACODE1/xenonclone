// Evidence for the two bank checks that Xero's API cannot answer on its own: Bank Balance and Unprocessed Bank.
//
// Three sources, strongest first, chosen per bank account:
//   1. an imported bank statement CSV (its closing balance and its unmatched lines);
//   2. a closing balance an accountant typed in;
//   3. the latest reading of Xero's own "Bank accounts" page taken by the Akrio Verify browser extension.
//
// The screen reading gives, per account, Xero's "Statement balance" (the bank feed's latest balance) and
// "Balance in Xero", read at the same moment, plus the number of items waiting to be reconciled. That is
// what Xenon shows as "Per Xero Statement" / "Per Xero TB" on its Bank Balance check and as
// "N unprocessed bank transactions" on its Unprocessed Bank check.
//
// A reading older than STALE_AFTER_DAYS is never used: the check then says it needs a fresh reading
// instead of reporting a pass from old figures. Nothing here touches a database; the caller passes the
// rows in, so the dashboard calculation and the detail page always agree.
const crypto = require('crypto');
const { readingFreshness } = require('./bankScreenReading');

const SCREEN_SOURCE = 'Xero Bank accounts screen';
const NEEDS_BANK_UPDATE = 'needs_bank_update';

const normaliseName = name => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
const finite = value => value != null && value !== '' && Number.isFinite(Number(value));
const pennies = value => Math.round(Number(value) * 100);
const isoDate = date => (date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null);

// A screen account that matches no Xero bank account Verify knows about still needs a stable identity, so
// a review state set on it survives the next reading. Built from the name only, never the batch or position.
function syntheticAccountId(name) {
  return 'screen:' + crypto.createHash('sha1').update(normaliseName(name)).digest('hex').slice(0, 16);
}

function formatReadAt(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function evidenceFreshness(date, now) {
  if (!date) return 'unknown';
  const days = (Date.parse(now.toISOString().slice(0, 10)) - Date.parse(String(date).slice(0, 10))) / 86400000;
  return Number.isFinite(days) && days > 35 ? 'stale' : 'current';
}

// Xero shows "Reconciled" instead of a number when nothing is waiting, so that is an explicit zero.
// Anything else without a number is unknown, never zero.
function screenItemCount(account) {
  if (Number.isInteger(account.itemsToReconcile) && account.itemsToReconcile >= 0) return account.itemsToReconcile;
  return account.reconciled ? 0 : null;
}

// Xero leaves "Balance in Xero" off an account that is fully reconciled and whose balances agree (it shows
// "Reconciled" and the statement balance only). There the balance in Xero is the statement balance. If the two
// disagreed, Xero would show both figures and "Why is this different?" (balancesDiffer).
function screenXeroBalance(account) {
  if (finite(account.balanceInXero)) return Number(account.balanceInXero);
  if (account.reconciled && !account.balancesDiffer && finite(account.statementBalance)) return Number(account.statementBalance);
  return null;
}

function buildBankEvidence({
  reconciliation = [], imports = [], unmatchedLines = [], excludedBankAccountIds = new Set(),
  reading = null, lineSummaries = [], now = new Date(),
} = {}) {
  const excluded = excludedBankAccountIds instanceof Set ? excludedBankAccountIds : new Set(excludedBankAccountIds || []);
  const byId = new Map(reconciliation.map(row => [row.bank_account_id, row]));
  const idByName = new Map();
  for (const row of reconciliation) {
    const key = normaliseName(row.bank_account_name);
    // Two Xero accounts can't share a name, but if old rows ever do, refuse to guess between them.
    idByName.set(key, idByName.has(key) ? null : row.bank_account_id);
  }

  const freshness = reading ? readingFreshness(reading.readAt, now) : null;
  const screenUsable = freshness === 'current' && Array.isArray(reading.accounts);
  const readAt = reading && reading.readAt instanceof Date ? reading.readAt : (reading ? new Date(reading.readAt) : null);
  const provenance = reading ? {
    readAt: readAt && Number.isFinite(readAt.getTime()) ? readAt.toISOString() : null,
    readByName: reading.readByName || null,
    batchId: reading.batchId ?? null,
  } : null;
  const screenAccounts = (reading && Array.isArray(reading.accounts) ? reading.accounts : []).map(account => {
    const matchedId = idByName.get(normaliseName(account.accountName)) || null;
    return { account, matchedId, accountId: matchedId || syntheticAccountId(account.accountName) };
  });

  // ---- Bank Balance ----
  const csvByAccount = new Map(imports.map(item => [item.bank_account_id, item]));
  const evidence = [];
  const coveredByStatement = new Set();
  for (const item of imports) {
    const xero = byId.get(item.bank_account_id);
    coveredByStatement.add(item.bank_account_id);
    evidence.push({
      accountId: item.bank_account_id, name: item.bank_account_name,
      statementBalance: item.closing_balance, statementDate: item.statement_end_date,
      evidenceSource: 'CSV statement', evidenceFreshness: evidenceFreshness(item.statement_end_date, now),
      xeroBalance: xero ? xero.xero_calculated_balance : null, xeroBalanceAsOf: xero ? xero.xero_balance_as_of : null,
    });
  }
  for (const row of reconciliation) {
    if (coveredByStatement.has(row.bank_account_id) || row.statement_balance == null) continue;
    coveredByStatement.add(row.bank_account_id);
    const date = row.statement_balance_updated_at ? String(row.statement_balance_updated_at).slice(0, 10) : null;
    evidence.push({
      accountId: row.bank_account_id, name: row.bank_account_name,
      statementBalance: row.statement_balance, statementDate: date,
      evidenceSource: 'Manual closing balance', evidenceFreshness: evidenceFreshness(date, now),
      xeroBalance: row.xero_calculated_balance, xeroBalanceAsOf: row.xero_balance_as_of,
    });
  }
  if (screenUsable) {
    for (const { account, matchedId, accountId } of screenAccounts) {
      if (matchedId && coveredByStatement.has(matchedId)) continue;
      // No bank feed (or a feed that has never sent a balance): nothing to compare, so no evidence.
      const xeroBalance = screenXeroBalance(account);
      if (!finite(account.statementBalance) || xeroBalance == null) continue;
      evidence.push({
        accountId, name: account.accountName, matched: !!matchedId,
        statementBalance: Number(account.statementBalance), statementDate: isoDate(readAt),
        statementDateLabel: account.statementDateLabel || null,
        evidenceSource: SCREEN_SOURCE, evidenceFreshness: 'current',
        xeroBalance, xeroBalanceAsOf: isoDate(readAt),
        ...provenance,
      });
    }
  }
  const included = evidence.filter(item => !excluded.has(item.accountId));
  const comparable = included.filter(item => finite(item.statementBalance) && finite(item.xeroBalance));
  const compared = comparable.map(item => {
    const differencePence = pennies(item.statementBalance) - pennies(item.xeroBalance);
    return { ...item, difference: differencePence / 100, discrepancy: Math.abs(differencePence) / 100, _pence: Math.abs(differencePence) };
  });
  // A difference of a penny is rounding; two pence or more is a real difference.
  const balanceFindings = compared.filter(item => item._pence > 1).map(({ _pence, ...item }) => item);
  const staleReading = !!reading && !screenUsable;
  // A fresh reading in which Xero lists no bank accounts at all: nothing can be out, so the check is clean.
  const emptyFreshReading = screenUsable && !reading.accounts.length;
  let balanceLabel;
  if (!included.length && emptyFreshReading) balanceLabel = `statement_comparison_as_of_${isoDate(readAt)}`;
  else if (!included.length) balanceLabel = staleReading && reading.accounts && reading.accounts.length ? NEEDS_BANK_UPDATE : 'not_configured';
  else if (comparable.length !== included.length) balanceLabel = 'needs_sync';
  else balanceLabel = `statement_comparison_as_of_${included.map(item => item.statementDate).filter(Boolean).sort().pop() || isoDate(now)}`;
  const bankBalance = {
    count: !included.length && emptyFreshReading ? 0
      : !included.length || comparable.length !== included.length ? (balanceFindings.length || null) : balanceFindings.length,
    value: balanceFindings.reduce((sum, item) => sum + item.discrepancy, 0),
    findings: balanceFindings,
    label: balanceLabel,
  };

  // Per-account cards for the Bank Balance detail page: every account any source knows about.
  const evidenceById = new Map(evidence.map(item => [item.accountId, item]));
  const screenById = new Map(screenAccounts.map(entry => [entry.accountId, entry]));
  const cardIds = [...new Set([...reconciliation.map(row => row.bank_account_id), ...screenAccounts.map(entry => entry.accountId)])];
  const accounts = cardIds.map(accountId => {
    const row = byId.get(accountId) || null;
    const screen = screenById.get(accountId) || null;
    const used = evidenceById.get(accountId) || null;
    const csv = csvByAccount.get(accountId) || null;
    const bankStatementBalance = csv ? csv.closing_balance : (row && row.statement_balance != null ? row.statement_balance : null);
    const xeroStatementBalance = screen && screenUsable && finite(screen.account.statementBalance) ? Number(screen.account.statementBalance) : null;
    const xeroBalance = used ? used.xeroBalance : (row ? row.xero_calculated_balance : null);
    const comparison = used && finite(used.statementBalance) && finite(used.xeroBalance)
      ? (pennies(used.statementBalance) - pennies(used.xeroBalance)) / 100 : null;
    return {
      accountId,
      name: row ? row.bank_account_name : screen.account.accountName,
      canEdit: !!row,
      excluded: excluded.has(accountId),
      bankStatementBalance,
      bankStatementSource: csv ? 'CSV statement' : (bankStatementBalance != null ? 'Manual closing balance' : null),
      xeroStatementBalance,
      xeroStatementDateLabel: screen ? screen.account.statementDateLabel || null : null,
      xeroBalance,
      xeroBalanceSource: used && used.evidenceSource === SCREEN_SOURCE ? SCREEN_SOURCE : 'Xero Bank Summary report',
      xeroBalanceAsOf: used ? used.xeroBalanceAsOf : (row ? row.xero_balance_as_of : null),
      evidenceSource: used ? used.evidenceSource : null,
      difference: comparison,
      hasDifference: comparison != null && Math.abs(pennies(comparison)) > 1,
      feedProblem: !!(screen && screen.account.feedProblem),
      stoppedImporting: !!(screen && screen.account.stoppedImporting),
      noFeed: !!(screen && screen.account.noFeed),
    };
  });

  // ---- Unprocessed Bank ----
  const csvAccounts = new Set(imports.map(item => item.bank_account_id));
  const linesByAccount = new Map((lineSummaries || []).map(summary => [normaliseName(summary.accountName), summary]));
  const screenFindings = [];
  let knownScreenAccounts = 0;
  let screenItems = 0;
  if (screenUsable) {
    for (const { account, matchedId, accountId } of screenAccounts) {
      if (matchedId && csvAccounts.has(matchedId)) continue; // the imported statement already answers this account
      if (excluded.has(accountId)) continue;
      const items = screenItemCount(account);
      if (items == null) continue;
      knownScreenAccounts++;
      if (!items) continue;
      screenItems += items;
      // The account's stored "items to reconcile" list gives the money and the age, but only when it is the
      // whole list and still agrees with the count on Xero's page; an old or partial list is not used.
      const stored = linesByAccount.get(normaliseName(account.accountName));
      const lines = stored && !stored.truncated && stored.lineCount === items ? stored : null;
      // `id` (not accountId) gives these rows their own identity, separate from any CSV line of the same account.
      screenFindings.push({
        id: 'bank-screen:' + accountId, bankAccountId: accountId, account: account.accountName,
        itemsToReconcile: items,
        // Xero shows the statement date without a year; it is kept exactly as shown.
        statementDate: account.statementDateLabel || null,
        bankFeed: account.stoppedImporting ? 'Stopped importing' : account.feedProblem ? 'Feed problem'
          : account.noFeed ? 'No bank feed' : 'OK',
        ...(lines ? {
          potentialValue: lines.value, value: lines.value, oldestItem: lines.oldest,
          ageDays: lines.oldest ? Math.max(0, Math.round((Date.parse(isoDate(now)) - Date.parse(lines.oldest)) / 86400000)) : null,
          oldestAge: lines.oldest ? Math.max(0, Math.round((Date.parse(isoDate(now)) - Date.parse(lines.oldest)) / 86400000)) + ' days' : null,
        } : {}),
        evidenceSource: SCREEN_SOURCE,
        lastRead: provenance.readAt ? formatReadAt(provenance.readAt) + (provenance.readByName ? ' by ' + provenance.readByName : '') : null,
        ...provenance,
      });
    }
  }
  const csvValue = unmatchedLines.reduce((sum, line) => sum + Math.abs(Number(line.amount) || 0), 0);
  let unprocessedLabel;
  if (imports.length) unprocessedLabel = `imported_statements_${imports.map(item => item.statement_end_date).sort().pop()}`;
  else if (knownScreenAccounts || emptyFreshReading) unprocessedLabel = `bank_screen_${isoDate(readAt)}`;
  else unprocessedLabel = reading && (reading.accounts || []).length ? NEEDS_BANK_UPDATE : 'not_configured';
  const unprocessedConfigured = !!imports.length || knownScreenAccounts > 0 || emptyFreshReading;
  const unprocessed = {
    count: unprocessedConfigured ? unmatchedLines.length + screenFindings.length : null,
    value: csvValue + screenFindings.reduce((sum, finding) => sum + (finding.value || 0), 0),
    findings: [...unmatchedLines, ...screenFindings],
    screenItems,
    label: unprocessedLabel,
  };

  return {
    accounts, bankBalance, unprocessed,
    reading: reading ? { ...provenance, freshness, usable: screenUsable } : null,
  };
}

// The latest reading, or null. The reading store is MySQL; if it can't be reached the checks carry on as
// if there were no reading (so they say "Not configured", never "OK"), and the failure is logged.
async function loadLatestBankScreenReading(orgId, options = {}) {
  try {
    const get = options.getLatestBankScreenReading || require('../db/bankScreenReadings').getLatestReading;
    return (await get(orgId)) || null;
  } catch (error) {
    (options.logger || console).error(`[bank-screen] could not load the latest reading for org ${orgId}:`, error && error.message);
    return null;
  }
}

// Summaries of the stored "items to reconcile" lists, or [] when they cannot be loaded.
async function loadBankLineSummaries(orgId, options = {}) {
  try {
    const get = options.getBankLineSummaries || require('../db/bankScreenReadings').getLineSummaries;
    return (await get(orgId)) || [];
  } catch (error) {
    (options.logger || console).error(`[bank-screen] could not load the stored lines for org ${orgId}:`, error && error.message);
    return [];
  }
}

module.exports = {
  buildBankEvidence, loadLatestBankScreenReading, loadBankLineSummaries, syntheticAccountId, screenItemCount, screenXeroBalance,
  SCREEN_SOURCE, NEEDS_BANK_UPDATE,
};
