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

test('a whole-pound filing is not held to penny precision it was never filed at', () => {
  // Every client whose accounts were filed to the nearest £1 was reporting the filing's own
  // rounding as an opening-balance difference. Xenon reports all three of these as clean.
  assert.equal(filedAccountsComparison(-21385, -21385.25).hasIssue, false, '4X4&MORE £0.25');
  assert.equal(filedAccountsComparison(-2268, -2267.88).hasIssue, false, 'Handymanz £0.12');
  assert.equal(filedAccountsComparison(1000952, 1000952.99).hasIssue, false, 'Rose £0.99');
  // The tolerance is rounding-sized only: a real difference still reports, as Xenon does for MBX.
  assert.equal(filedAccountsComparison(1000952, 886562).hasIssue, true, 'MBX £114,390');
  assert.equal(filedAccountsComparison(1000, 998.5).hasIssue, true, '£1.50 exceeds rounding');
  // A filing that does carry pence was filed at that precision, so it keeps the penny tolerance.
  assert.equal(filedAccountsComparison(1000.5, 1000.25).hasIssue, true);
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

const { extractNetAssetsFromBalanceSheet } = require('../src/services/statementEvidence');

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
