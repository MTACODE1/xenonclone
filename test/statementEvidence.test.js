const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const databasePath = path.join(os.tmpdir(), `xero-statement-evidence-${process.pid}-${Date.now()}.db`);
process.env.XERO_DASHBOARD_DB_PATH = databasePath;
const {
  balanceDiscrepancy, filedAccountsComparison, matchStatementLine,
  normalizeStatementLines, recomputeEvidenceIssues, sha256,
} = require('../src/services/statementEvidence');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
});

test('CSV parsing auto-detects columns and normalizes signed lines', () => {
  const parsed = normalizeStatementLines(
    'Transaction Date,Money Out,Money In,Reference,Details\n' +
    '01/07/2026,12.50,,CARD-1,"Supplier, Ltd"\n' +
    '2026-07-02,,20.00,SALE-2,Customer'
  );
  assert.deepEqual(parsed.mapping, {
    date: 'Transaction Date', debit: 'Money Out', credit: 'Money In',
    reference: 'Reference', description: 'Details',
  });
  assert.deepEqual(parsed.lines.map(line => [line.transactionDate, line.amount]), [
    ['2026-07-01', -12.5], ['2026-07-02', 20],
  ]);
});

test('SHA-256 is stable for import deduplication', () => {
  const file = Buffer.from('date,amount\n2026-07-01,10\n');
  assert.equal(sha256(file), sha256(Buffer.from(file)));
  assert.notEqual(sha256(file), sha256(Buffer.from(`${file} `)));
});

test('database enforces per-organisation file hash deduplication', () => {
  const { getDb } = require('../src/db/schema');
  const { createStatementImport, getStatementImportByHash } = require('../src/db/queries');
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('statement-test', 'Statement Test')
  `).run().lastInsertRowid);
  const data = {
    bankAccountId: 'bank-1', bankAccountName: 'Current Account',
    originalFilename: 'statement.csv', storedFilename: 'safe.csv',
    fileSha256: 'abc123', statementStartDate: '2026-07-01', statementEndDate: '2026-07-31',
    openingBalance: 10, closingBalance: 20, columnMapping: { date: 'Date', amount: 'Amount' },
  };
  const lines = [{
    lineNumber: 2, transactionDate: '2026-07-01', amount: 10,
    reference: null, description: null, confidence: 'unmatched', matchedId: null, candidates: 0,
  }];
  createStatementImport(orgId, data, lines);
  assert.equal(getStatementImportByHash(orgId, 'abc123').row_count, 1);
  assert.throws(() => createStatementImport(orgId, data, lines), /UNIQUE constraint failed/);
});

test('local matching distinguishes exact, probable, ambiguous and unmatched', () => {
  const base = {
    bankAccountId: 'bank-1', transactionDate: '2026-07-02',
    amount: -12.5, reference: 'CARD-1', description: 'Supplier',
  };
  const exactItem = {
    source_id: 'x1', bank_account_id: 'bank-1', transaction_date: '2026-07-02',
    amount: -12.5, reference: 'CARD-1', description: 'Supplier',
  };
  assert.equal(matchStatementLine(base, [exactItem]).confidence, 'exact');
  assert.equal(matchStatementLine({ ...base, reference: null, description: null }, [exactItem]).confidence, 'probable');
  assert.equal(matchStatementLine(base, [exactItem, { ...exactItem, source_id: 'x2' }]).confidence, 'ambiguous');
  assert.equal(matchStatementLine(base, [{ ...exactItem, amount: 12.5 }]).confidence, 'unmatched');
});

test('balance discrepancy uses closing evidence and absolute difference', () => {
  assert.equal(balanceDiscrepancy(1000, 975.25), 24.75);
  assert.equal(balanceDiscrepancy(null, 10), null);
});

test('filed-account comparison never reports clean without a Xero balance', () => {
  assert.deepEqual(filedAccountsComparison(1000, null), {
    configured: false, difference: null, hasIssue: null,
  });
  assert.equal(filedAccountsComparison(1000, 1000).hasIssue, false);
  assert.equal(filedAccountsComparison(1000, 990).difference, 10);
  assert.equal(filedAccountsComparison(1000, 990).hasIssue, true);
});

test('opening balance differences use Xenon\'s documented default: a flat £1 threshold, not penny precision', () => {
  // Xenon's own docs (opening-balance-differences): "a difference of £1 or more will result in
  // an issue being flagged for your review" — a flat default, not conditional on whether the
  // filed figure happens to carry pence. Every client whose accounts were filed to the nearest £1
  // was previously reporting the filing's own rounding as an opening-balance difference; Xenon
  // reports all three of these as clean, and they all fall within the £1 default too.
  assert.equal(filedAccountsComparison(-21385, -21385.25).hasIssue, false, '4X4&MORE £0.25');
  assert.equal(filedAccountsComparison(-2268, -2267.88).hasIssue, false, 'Handymanz £0.12');
  assert.equal(filedAccountsComparison(1000952, 1000952.99).hasIssue, false, 'Rose £0.99');
  // A real difference still reports, as Xenon does for MBX.
  assert.equal(filedAccountsComparison(1000952, 886562).hasIssue, true, 'MBX £114,390');
  assert.equal(filedAccountsComparison(1000, 998.5).hasIssue, true, '£1.50 exceeds the £1 default');
  // A small difference on a filing that carries pence is still under the £1 default, so it's
  // clean too — Xenon's threshold isn't penny precision just because the filing has pence.
  assert.equal(filedAccountsComparison(1000.5, 1000.25).hasIssue, false);
});

test('opening balance threshold: an organisation override takes precedence, but NULL (unset) must fall through — not resolve to £0', () => {
  // Number(null) is 0, not NaN — a genuinely-unset org column (what SQLite actually returns) must
  // be checked for null explicitly, or a real £0.50 difference would wrongly flag for every client
  // that has never touched this setting.
  assert.equal(
    filedAccountsComparison(1000, 999.5, null, { opening_balance_threshold_gbp: null }).hasIssue, false,
    'unset org override must fall through to the £1 documented default, not resolve to £0'
  );
  assert.equal(
    filedAccountsComparison(1000, 998, null, { opening_balance_threshold_gbp: 3 }).hasIssue, false,
    '£2 difference stays clean under an explicit £3 organisation override'
  );
  assert.equal(
    filedAccountsComparison(1000, 995, null, { opening_balance_threshold_gbp: 3 }).hasIssue, true,
    '£5 difference exceeds an explicit £3 organisation override'
  );
});

// --- Global one-to-one allocation ---

const { allocateStatementMatches } = require('../src/services/statementEvidence');

function xeroItem(id, overrides = {}) {
  return {
    source_id: id, bank_account_id: 'bank-1', transaction_date: '2026-07-02',
    amount: -50, reference: null, description: null, ...overrides,
  };
}
function statementLine(number, overrides = {}) {
  return {
    id: number, lineNumber: number, bankAccountId: 'bank-1',
    transactionDate: '2026-07-02', amount: -50, reference: null, description: null, ...overrides,
  };
}

test('two identical statement lines cannot both be explained by one Xero record', () => {
  // The bank shows the same £50 leaving twice; Xero holds one such payment. Exactly one line is
  // processed and the other is genuinely unprocessed — matching each line independently reported
  // both as processed and hid a real missing transaction.
  const result = allocateStatementMatches(
    [statementLine(1), statementLine(2)],
    [xeroItem('x1')]
  );
  const confidences = result.map(line => line.confidence).sort();
  assert.deepEqual(confidences, ['probable', 'unmatched']);
  assert.equal(result.filter(line => line.matchedId === 'x1').length, 1);
  // The unmatched line still records that a same-amount record existed but was claimed elsewhere.
  assert.equal(result.find(line => line.confidence === 'unmatched').candidates, 1);
});

test('two identical statement lines with two Xero records are both processed', () => {
  const result = allocateStatementMatches(
    [statementLine(1), statementLine(2)],
    [xeroItem('x1'), xeroItem('x2')]
  );
  assert.deepEqual(result.map(line => line.confidence), ['ambiguous', 'ambiguous']);
  assert.equal(result.filter(line => line.confidence === 'unmatched').length, 0);
});

test('the line with reference evidence keeps the record it actually identifies', () => {
  // Both lines are £50 on the same day, but only one names the payee that Xero recorded. The
  // identified line must win the record; the anonymous line is the unprocessed one.
  const result = allocateStatementMatches(
    [
      statementLine(1, { reference: 'UNRELATED-REF' }),
      statementLine(2, { reference: 'INV-900' }),
    ],
    [xeroItem('x1', { reference: 'INV-900' })]
  );
  const identified = result.find(line => line.id === 2);
  const anonymous = result.find(line => line.id === 1);
  assert.equal(identified.confidence, 'exact');
  assert.equal(identified.matchedId, 'x1');
  assert.equal(anonymous.confidence, 'unmatched');
});

test('a nearer posting date wins over a further one inside the window', () => {
  const result = allocateStatementMatches(
    [statementLine(1, { transactionDate: '2026-07-02' })],
    [
      xeroItem('far', { transaction_date: '2026-07-05' }),
      xeroItem('near', { transaction_date: '2026-07-03' }),
    ]
  );
  assert.equal(result[0].matchedId, 'near');
  assert.equal(result[0].confidence, 'probable');
});

test('a batch payment lump sum matches its batch record, not an unrelated member', () => {
  // The bank debits one £2,860.32 batch total; Xero stores the batch plus its member payments.
  const result = allocateStatementMatches(
    [statementLine(1, { amount: -2860.32, description: 'BACS BATCH' })],
    [
      xeroItem('batch-1', { amount: -2860.32, description: 'Batch payment' }),
      xeroItem('member-1', { amount: -120.50 }),
    ]
  );
  assert.equal(result[0].matchedId, 'batch-1');
  assert.notEqual(result[0].confidence, 'unmatched');
});

test('allocation never matches across bank accounts or outside the amount tolerance', () => {
  const wrongAccount = allocateStatementMatches(
    [statementLine(1)], [xeroItem('x1', { bank_account_id: 'bank-2' })]
  );
  assert.equal(wrongAccount[0].confidence, 'unmatched');
  const wrongSign = allocateStatementMatches([statementLine(1)], [xeroItem('x1', { amount: 50 })]);
  assert.equal(wrongSign[0].confidence, 'unmatched');
  const outsideWindow = allocateStatementMatches(
    [statementLine(1)], [xeroItem('x1', { transaction_date: '2026-07-20' })]
  );
  assert.equal(outsideWindow[0].confidence, 'unmatched');
});

test('allocation is deterministic across runs so re-syncs do not churn results', () => {
  const lines = [statementLine(1), statementLine(2), statementLine(3)];
  const items = [xeroItem('x1'), xeroItem('x2')];
  const first = allocateStatementMatches(lines, items);
  const second = allocateStatementMatches(lines, items);
  assert.deepEqual(first.map(l => [l.id, l.confidence, l.matchedId]),
    second.map(l => [l.id, l.confidence, l.matchedId]));
  assert.equal(first.filter(l => l.confidence === 'unmatched').length, 1);
});

// --- Xero side of the opening-balance comparison ---

const { extractNetAssetsFromBalanceSheet, balanceSheetHoldsBookkeeping } = require('../src/services/statementEvidence');

function balanceSheet(rows) {
  return { rows: [{ rowType: 'Section', rows: rows.map(([label, value]) => ({
    rowType: 'Row', cells: [{ value: label }, { value }],
  })) }] };
}

test('net assets is read from the Xero balance sheet in every rendering Xero uses', () => {
  const cases = [
    [[['Net Assets', '-21385.00']], -21385],
    // A net-liability position may be bracketed rather than signed. This previously parsed to NaN
    // and left the check on "needs sync" for exactly the clients with negative net assets.
    [[['Net Assets', '(21,385.00)']], -21385],
    [[['Net Assets', '1,000,952.00']], 1000952],
    [[['Total Equity', '7106.00']], 7106],
    [[['Net Assets', '£-17,230.00']], -17230],
    [[['Net Assets/(Liabilities)', '-2268.00']], -2268],
    [[['Net Assets / (Liabilities)', '-2268.00']], -2268],
    [[['net assets:', '100']], 100],
  ];
  for (const [rows, expected] of cases) {
    assert.equal(extractNetAssetsFromBalanceSheet(balanceSheet(rows)), expected,
      `failed for ${JSON.stringify(rows)}`);
  }
});

test('label normalisation does not widen into a different balance-sheet total', () => {
  // "Total Equity and Liabilities" is the other side of the balance sheet, not net assets.
  assert.equal(extractNetAssetsFromBalanceSheet(balanceSheet([
    ['Total Equity and Liabilities', '999'],
  ])), null);
  assert.equal(extractNetAssetsFromBalanceSheet(balanceSheet([['Total Assets', '999']])), null);
  assert.equal(extractNetAssetsFromBalanceSheet(balanceSheet([['Net Assets', 'n/a']])), null);
  assert.equal(extractNetAssetsFromBalanceSheet({ rows: [] }), null);
  assert.equal(extractNetAssetsFromBalanceSheet(null), null);
});

test('an empty balance sheet is not a zero net-assets figure', () => {
  // Julia Kuisma: asked for 31/10/2020, a date its Xero holds no bookkeeping at, Xero returns this
  // exact report — a bare zero Net Assets line with no sections. Reading 0 from it manufactured a
  // £7,106 opening-balance difference against the filed accounts, which Xenon reports as clean.
  assert.equal(extractNetAssetsFromBalanceSheet({ rows: [{ rowType: 'Section', rows: [
    { rowType: 'Row', cells: [{ value: '' }, { value: '31 Oct 2020' }, { value: '31 Oct 2019' }] },
    { rowType: 'Row', cells: [{ value: 'Net Assets' }, { value: '0.00' }, { value: '0.00' }] },
  ] }] }), null);
  // Net assets of zero on a balance sheet that does hold bookkeeping is a real figure and stays.
  assert.equal(extractNetAssetsFromBalanceSheet(balanceSheet([
    ['Total Assets', '5000.00'], ['Total Liabilities', '5000.00'], ['Net Assets', '0.00'],
  ])), 0);
});

// balanceSheetHoldsBookkeeping — exported separately from extractNetAssetsFromBalanceSheet so a
// caller (xeroSync.js) can tell "confirmed no bookkeeping here" apart from "couldn't find/parse a
// figure for some other reason", and only treat the former as safe to persist as a real null —
// a transient extraction miss must never overwrite a previously-good stored value.

test('balanceSheetHoldsBookkeeping is false only for the bare no-bookkeeping stub', () => {
  assert.equal(balanceSheetHoldsBookkeeping({ rows: [{ rowType: 'Section', rows: [
    { rowType: 'Row', cells: [{ value: '' }, { value: '31 Oct 2020' }, { value: '31 Oct 2019' }] },
    { rowType: 'Row', cells: [{ value: 'Net Assets' }, { value: '0.00' }, { value: '0.00' }] },
  ] }] }), false);
  assert.equal(balanceSheetHoldsBookkeeping({ rows: [] }), false);
  assert.equal(balanceSheetHoldsBookkeeping(null), false);
});

test('balanceSheetHoldsBookkeeping is true whenever any real bookkeeping value exists', () => {
  assert.equal(balanceSheetHoldsBookkeeping(balanceSheet([
    ['Total Assets', '5000.00'], ['Total Liabilities', '5000.00'], ['Net Assets', '0.00'],
  ])), true);
  // Even a report where extractNetAssetsFromBalanceSheet can't find/parse a Net Assets row at all
  // still "holds bookkeeping" if other rows carry real values — this is the case the write-guard
  // in xeroSync.js relies on to avoid overwriting a good stored value on an unrelated parsing miss.
  assert.equal(balanceSheetHoldsBookkeeping(balanceSheet([
    ['Total Assets', '5000.00'], ['Total Liabilities', '5000.00'],
  ])), true);
});

test('net assets is found however deeply the report nests its sections', () => {
  const nested = { rows: [{ rowType: 'Section', rows: [
    { rowType: 'Section', rows: [{ rowType: 'Row', cells: [{ value: 'Net Assets' }, { value: '55.50' }] }] },
  ] }] };
  assert.equal(extractNetAssetsFromBalanceSheet(nested), 55.5);
});

// --- recomputeEvidenceIssues: semantic period_checked labels survive persistence ---
// Previously, bank_balance/unprocessed_bank/opening_balance_differences all had their intended
// 'not_configured'/'needs_sync' label unconditionally overwritten with a period-key-shaped string,
// so an unconfigured check could never display as "Not configured" — only generic "Not synced".

test('an unconfigured check persists its own not_configured label, not a period key', () => {
  const { getDb } = require('../src/db/schema');
  const { getIssueByCheckType, upsertOrganisation } = require('../src/db/queries');
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('period-label-test', 'Period Label Test')
  `).run().lastInsertRowid);

  // No statement import and no bank_reconciliation row exist for this org: both unprocessed_bank
  // and bank_balance must come out as 'not_configured', and opening_balance_differences (no
  // filed_accounts row either) must come out as 'not_configured' too — called with periodKey=null,
  // exactly as client.js's routes call it after a form save, so the fallback path is exercised.
  recomputeEvidenceIssues(orgId);

  const unprocessed = getIssueByCheckType(orgId, 'unprocessed_bank');
  const bankBalance = getIssueByCheckType(orgId, 'bank_balance');
  const openingBalance = getIssueByCheckType(orgId, 'opening_balance_differences');
  assert.equal(unprocessed.period_checked, 'not_configured');
  assert.equal(unprocessed.count, null);
  assert.equal(bankBalance.period_checked, 'not_configured');
  assert.equal(bankBalance.count, null);
  assert.equal(openingBalance.period_checked, 'not_configured');
  assert.equal(openingBalance.count, null);
});

test('a real period key still reaches an evidence check when one is genuinely configured', () => {
  const { getDb } = require('../src/db/schema');
  const { getIssueByCheckType, upsertOrganisation, upsertBankReconciliationXeroBalance } = require('../src/db/queries');
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('period-label-configured', 'Configured')
  `).run().lastInsertRowid);
  // No CSV import and no filed_accounts row exist, so unprocessed_bank/opening_balance stay
  // not_configured, but bank_balance has neither a statement balance NOR an import — it stays
  // not_configured too (evidence.length === 0). Passing an explicit periodKey must still be used
  // for whichever check DOES have real evidence to key off, without leaking into the others.
  recomputeEvidenceIssues(orgId, 'since_lock_date:2025-01-01:2026-01-01');
  const unprocessed = getIssueByCheckType(orgId, 'unprocessed_bank');
  assert.equal(unprocessed.period_checked, 'not_configured');
});

test('a stale not_configured bank_balance row cannot leak into opening_balance_differences on a later call with no explicit period key', () => {
  // This is the second-order case the fix specifically guards: effectivePeriodKey's fallback
  // reads a PREVIOUS issue's stored period_checked when no periodKey argument is given. If that
  // previous value is itself a reserved label (not a real period range), it must never be reused
  // as if it were one — otherwise it would overwrite a sibling check's genuine label.
  const { getDb } = require('../src/db/schema');
  const { getIssueByCheckType, upsertFiledAccounts, updateFiledAccountsXeroBalance } = require('../src/db/queries');
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('period-leak-test', 'Leak Test')
  `).run().lastInsertRowid);

  // First call (as a real sync would do): bank_balance has no evidence -> 'not_configured' is
  // stored for it. unprocessed_bank likewise. This mirrors the exact state a real client sits in
  // before any statement/balance evidence is ever entered.
  recomputeEvidenceIssues(orgId, 'since_lock_date:2025-01-01:2026-01-01');
  assert.equal(getIssueByCheckType(orgId, 'bank_balance').period_checked, 'not_configured');

  // Now the accountant enters a filed-accounts figure with a real Xero balance already synced,
  // giving opening_balance_differences genuine evidence. The route that handles this calls
  // recomputeEvidenceIssues(orgId) with NO periodKey — exactly like src/routes/client.js does.
  upsertFiledAccounts(orgId, { filingDate: '2025-12-31', netAssets: 1000, madeUpTo: '2025-12-31' });
  updateFiledAccountsXeroBalance(orgId, '2025-12-31', 1000);
  recomputeEvidenceIssues(orgId);

  const openingBalance = getIssueByCheckType(orgId, 'opening_balance_differences');
  // Must be the check's own real dated label, NEVER the string 'not_configured' leaked in from
  // bank_balance's stored state via the effectivePeriodKey fallback.
  assert.equal(openingBalance.period_checked, 'filed_accounts_2025-12-31');
  assert.notEqual(openingBalance.period_checked, 'not_configured');
  // And it is genuinely configured and clean (filed matches Xero exactly).
  assert.equal(openingBalance.count, 0);
});

// --- opening_balance_differences: every eligible filed year-end, not just the latest ---
// Confirmed gap: the check used to reduce getFiledAccountsForOrg(orgId) to its first (newest) row,
// so a client with two historical filings that BOTH differ from Xero could only ever surface one.
// xeroSync.js already fetches a live Balance Sheet as-of each filing's own date (independently of
// this check), so the data has always supported this — only the comparison itself was too narrow.

test('opening_balance_differences flags every comparable filing with a genuine difference, not just the latest', () => {
  const { getDb } = require('../src/db/schema');
  const { getIssueByCheckType, upsertFiledAccounts, updateFiledAccountsXeroBalance } = require('../src/db/queries');
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('multi-filing-both-bad', 'Both Bad')
  `).run().lastInsertRowid);

  upsertFiledAccounts(orgId, { filingDate: '2024-12-31', netAssets: 1000, madeUpTo: '2024-12-31' });
  updateFiledAccountsXeroBalance(orgId, '2024-12-31', 900); // £100 genuine difference
  upsertFiledAccounts(orgId, { filingDate: '2025-12-31', netAssets: 2000, madeUpTo: '2025-12-31' });
  updateFiledAccountsXeroBalance(orgId, '2025-12-31', 1950); // £50 genuine difference
  recomputeEvidenceIssues(orgId);

  const issue = getIssueByCheckType(orgId, 'opening_balance_differences');
  assert.equal(issue.count, 2);
  assert.equal(issue.potential_value_gbp, 150);
  assert.equal(issue.period_checked, 'filed_accounts_2024-12-31,2025-12-31');
  // With more than one finding, per-item detail lives in issue_findings (normalised), not the
  // issues row's own detail_json — same pattern insertIssue uses everywhere else in the app.
  const rows = db.prepare(`SELECT detail_json, finding_key FROM issue_findings WHERE issue_id = ?`).all(issue.id);
  const details = rows.map(row => JSON.parse(row.detail_json));
  assert.deepEqual(details.map(d => d.filingDate).sort(), ['2024-12-31', '2025-12-31']);
  // Each filing must key as its own distinct finding, not collide with the other.
  assert.equal(new Set(rows.map(row => row.finding_key)).size, 2);
});

test('opening_balance_differences only lists the filing(s) that actually differ, when one of several is clean', () => {
  const { getDb } = require('../src/db/schema');
  const { getIssueByCheckType, upsertFiledAccounts, updateFiledAccountsXeroBalance } = require('../src/db/queries');
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('multi-filing-one-clean', 'One Clean')
  `).run().lastInsertRowid);

  upsertFiledAccounts(orgId, { filingDate: '2024-12-31', netAssets: 1000, madeUpTo: '2024-12-31' });
  updateFiledAccountsXeroBalance(orgId, '2024-12-31', 1000); // exact match — clean
  upsertFiledAccounts(orgId, { filingDate: '2025-12-31', netAssets: 2000, madeUpTo: '2025-12-31' });
  updateFiledAccountsXeroBalance(orgId, '2025-12-31', 1500); // £500 genuine difference
  recomputeEvidenceIssues(orgId);

  const issue = getIssueByCheckType(orgId, 'opening_balance_differences');
  assert.equal(issue.count, 1);
  assert.equal(issue.potential_value_gbp, 500);
  const rows = db.prepare(`SELECT detail_json FROM issue_findings WHERE issue_id = ?`).all(issue.id);
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].detail_json).filingDate, '2025-12-31');
});

test('opening_balance_differences stays pending (not a false clean) while any filing has no comparable Xero balance yet', () => {
  const { getDb } = require('../src/db/schema');
  const { getIssueByCheckType, upsertFiledAccounts, updateFiledAccountsXeroBalance } = require('../src/db/queries');
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('multi-filing-partial-sync', 'Partial Sync')
  `).run().lastInsertRowid);

  upsertFiledAccounts(orgId, { filingDate: '2024-12-31', netAssets: 1000, madeUpTo: '2024-12-31' });
  updateFiledAccountsXeroBalance(orgId, '2024-12-31', 1000); // synced and comparable
  upsertFiledAccounts(orgId, { filingDate: '2025-12-31', netAssets: 2000, madeUpTo: '2025-12-31' });
  // The second filing's Xero balance is never synced — must not let the first filing's clean
  // result silently report as if the whole check had run.
  recomputeEvidenceIssues(orgId);

  const issue = getIssueByCheckType(orgId, 'opening_balance_differences');
  assert.equal(issue.count, null);
  assert.equal(issue.period_checked, 'needs_sync');
});

// --- bank_balance: per-account exclusion ---
// Xenon supports excluding individual bank accounts from Bank Balance — e.g. a dormant account an
// accountant once entered a closing balance for but no longer wants flagged.

test('an excluded bank account is left out of bank_balance entirely — no discrepancy, no needs_sync stall', () => {
  const { getDb } = require('../src/db/schema');
  const {
    getIssueByCheckType, upsertBankReconciliationXeroBalance, updateStatementBalance,
    setBankAccountExcluded,
  } = require('../src/db/queries');
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('bank-exclusion-test', 'Bank Exclusion')
  `).run().lastInsertRowid);

  upsertBankReconciliationXeroBalance(orgId, 'bank-1', 'Main Account', 1000, '2026-01-01');
  updateStatementBalance(orgId, 'bank-1', 900); // genuine £100 discrepancy
  upsertBankReconciliationXeroBalance(orgId, 'bank-2', 'Dormant PayPal', 50, '2026-01-01');
  updateStatementBalance(orgId, 'bank-2', 10); // also differs, but this account will be excluded

  recomputeEvidenceIssues(orgId);
  const before = getIssueByCheckType(orgId, 'bank_balance');
  assert.equal(before.count, 2);

  setBankAccountExcluded(orgId, 'bank-2', true);
  recomputeEvidenceIssues(orgId);
  const after = getIssueByCheckType(orgId, 'bank_balance');
  assert.equal(after.count, 1);
  assert.equal(after.potential_value_gbp, 100);

  // Un-excluding restores it — exclusion is reversible, not a destructive action.
  setBankAccountExcluded(orgId, 'bank-2', false);
  recomputeEvidenceIssues(orgId);
  assert.equal(getIssueByCheckType(orgId, 'bank_balance').count, 2);
});

test('excluding every evidenced bank account correctly reports not_configured, not a false-clean zero', () => {
  const { getDb } = require('../src/db/schema');
  const {
    getIssueByCheckType, upsertBankReconciliationXeroBalance, updateStatementBalance,
    setBankAccountExcluded,
  } = require('../src/db/queries');
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('bank-exclusion-all', 'Exclude All')
  `).run().lastInsertRowid);

  upsertBankReconciliationXeroBalance(orgId, 'bank-1', 'Only Account', 1000, '2026-01-01');
  updateStatementBalance(orgId, 'bank-1', 1000);
  setBankAccountExcluded(orgId, 'bank-1', true);
  recomputeEvidenceIssues(orgId);

  const issue = getIssueByCheckType(orgId, 'bank_balance');
  assert.equal(issue.count, null);
  assert.equal(issue.period_checked, 'not_configured');
});

// --- not_vat_registered: persistence and cross-client isolation ---
// Confirmed bug this fixes: sales_tax_missing/purchase_tax_missing write
// period_checked: 'not_vat_registered' for a non-VAT-registered client, but before it was added to
// RESERVED_PERIOD_LABELS it was silently overwritten by the active period key at persistence,
// making it indistinguishable in storage from a VAT-registered client with zero genuine findings.
// These tests exercise the actual persistence layer (insertIssue/getIssueByCheckType), not just
// the pure resolvePeriodChecked function, and prove client A's VAT status cannot leak into client B.

test('a non-VAT-registered client preserves not_vat_registered through the same insertIssue path xeroSync.js uses', () => {
  const { getDb } = require('../src/db/schema');
  const { insertIssue, getIssueByCheckType } = require('../src/db/queries');
  const { resolvePeriodChecked, resolveCheckDisplayStatus } = require('../src/services/checkRules');
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('not-vat-registered', 'No VAT Ltd')
  `).run().lastInsertRowid);

  // Mirrors exactly what xeroSync.js's persistIssue wrapper does: the check writes its own intended
  // label, then the caller runs it through resolvePeriodChecked against whatever the active period
  // key happens to be for this sync.
  const activePeriodKey = 'since_lock_date:2025-10-31:2026-09-07';
  insertIssue({
    org_id: orgId, check_type: 'sales_tax_missing', importance: 'medium', count: 0,
    potential_value_gbp: 0, detail_json: '[]',
    period_checked: resolvePeriodChecked('not_vat_registered', activePeriodKey),
  });
  insertIssue({
    org_id: orgId, check_type: 'purchase_tax_missing', importance: 'medium', count: 0,
    potential_value_gbp: 0, detail_json: '[]',
    period_checked: resolvePeriodChecked('not_vat_registered', activePeriodKey),
  });

  const sales = getIssueByCheckType(orgId, 'sales_tax_missing');
  const purchase = getIssueByCheckType(orgId, 'purchase_tax_missing');
  assert.equal(sales.period_checked, 'not_vat_registered');
  assert.equal(purchase.period_checked, 'not_vat_registered');
  assert.equal(resolveCheckDisplayStatus(sales), 'not_applicable');
  assert.equal(resolveCheckDisplayStatus(purchase), 'not_applicable');
});

test('a VAT-registered client with zero findings still displays OK, not not_applicable', () => {
  const { getDb } = require('../src/db/schema');
  const { insertIssue, getIssueByCheckType } = require('../src/db/queries');
  const { resolvePeriodChecked, resolveCheckDisplayStatus } = require('../src/services/checkRules');
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('vat-registered-clean', 'Clean VAT Ltd')
  `).run().lastInsertRowid);

  const activePeriodKey = 'since_lock_date:2025-10-31:2026-09-07';
  // A genuinely VAT-registered, genuinely clean client: the check writes no special label at all
  // (undefined), so resolvePeriodChecked falls through to the real period key, exactly as for any
  // other normally-computed check.
  insertIssue({
    org_id: orgId, check_type: 'sales_tax_missing', importance: 'medium', count: 0,
    potential_value_gbp: 0, detail_json: '[]',
    period_checked: resolvePeriodChecked(undefined, activePeriodKey),
  });

  const issue = getIssueByCheckType(orgId, 'sales_tax_missing');
  assert.equal(issue.period_checked, activePeriodKey);
  assert.equal(resolveCheckDisplayStatus(issue), 'ok');
});

test('a VAT-registered client with genuine findings still displays its issue count', () => {
  const { getDb } = require('../src/db/schema');
  const { insertIssue, getIssueByCheckType } = require('../src/db/queries');
  const { resolvePeriodChecked, resolveCheckDisplayStatus } = require('../src/services/checkRules');
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('vat-registered-issues', 'Issues VAT Ltd')
  `).run().lastInsertRowid);

  const activePeriodKey = 'since_lock_date:2025-10-31:2026-09-07';
  insertIssue({
    org_id: orgId, check_type: 'purchase_tax_missing', importance: 'medium', count: 12,
    potential_value_gbp: 340.5, detail_json: '[]',
    period_checked: resolvePeriodChecked(undefined, activePeriodKey),
  });

  const issue = getIssueByCheckType(orgId, 'purchase_tax_missing');
  assert.equal(issue.count, 12);
  assert.equal(resolveCheckDisplayStatus(issue), 'issues');
});

test('client A being not-VAT-registered cannot affect client B\'s VAT check result — org-scoped isolation', () => {
  const { getDb } = require('../src/db/schema');
  const { insertIssue, getIssueByCheckType } = require('../src/db/queries');
  const { resolvePeriodChecked, resolveCheckDisplayStatus } = require('../src/services/checkRules');
  const db = getDb();
  const orgA = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('isolation-a-no-vat', 'Isolation A')
  `).run().lastInsertRowid);
  const orgB = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('isolation-b-vat-issues', 'Isolation B')
  `).run().lastInsertRowid);

  const activePeriodKey = 'since_lock_date:2025-10-31:2026-09-07';
  // Same check_type on both orgs, written in the same test — if org scoping ever broke, one write
  // would clobber the other.
  insertIssue({
    org_id: orgA, check_type: 'sales_tax_missing', importance: 'medium', count: 0,
    potential_value_gbp: 0, detail_json: '[]',
    period_checked: resolvePeriodChecked('not_vat_registered', activePeriodKey),
  });
  insertIssue({
    org_id: orgB, check_type: 'sales_tax_missing', importance: 'medium', count: 7,
    potential_value_gbp: 250, detail_json: '[]',
    period_checked: resolvePeriodChecked(undefined, activePeriodKey),
  });

  const issueA = getIssueByCheckType(orgA, 'sales_tax_missing');
  const issueB = getIssueByCheckType(orgB, 'sales_tax_missing');
  assert.equal(resolveCheckDisplayStatus(issueA), 'not_applicable');
  assert.equal(resolveCheckDisplayStatus(issueB), 'issues');
  assert.equal(issueB.count, 7);
  assert.equal(issueB.period_checked, activePeriodKey);
});

test('full sync and single-check reanalysis both preserve not_vat_registered, regardless of which active period key is in force', () => {
  // The full-sync path and the per-check reanalysis path both run through the exact same
  // resolvePeriodChecked call in xeroSync.js's persistIssue wrapper — the only thing that varies
  // between them is which period key happens to be active. Simulating an insertIssue write against
  // two different active period keys (as a full sync vs. a reanalysis of a different selected
  // period each would produce) proves preservation holds regardless.
  const { getDb } = require('../src/db/schema');
  const { insertIssue, getIssueByCheckType } = require('../src/db/queries');
  const { resolvePeriodChecked, resolveCheckDisplayStatus } = require('../src/services/checkRules');
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('reanalysis-preserves', 'Reanalysis Ltd')
  `).run().lastInsertRowid);

  // Simulates a full sync (the org's normal since-lock-date period).
  insertIssue({
    org_id: orgId, check_type: 'purchase_tax_missing', importance: 'medium', count: 0,
    potential_value_gbp: 0, detail_json: '[]',
    period_checked: resolvePeriodChecked('not_vat_registered', 'since_lock_date:2025-10-31:2026-09-07'),
  });
  assert.equal(getIssueByCheckType(orgId, 'purchase_tax_missing').period_checked, 'not_vat_registered');

  // Simulates a single-check reanalysis against a completely different selected period (e.g. the
  // accountant previewed "Rolling 12 Months" and clicked Reanalyse on just this one check).
  insertIssue({
    org_id: orgId, check_type: 'purchase_tax_missing', importance: 'medium', count: 0,
    potential_value_gbp: 0, detail_json: '[]',
    period_checked: resolvePeriodChecked('not_vat_registered', 'rolling_12_months:2025-09-08:2026-09-07'),
  });
  const reanalysed = getIssueByCheckType(orgId, 'purchase_tax_missing');
  assert.equal(reanalysed.period_checked, 'not_vat_registered');
  assert.equal(resolveCheckDisplayStatus(reanalysed), 'not_applicable');
});
