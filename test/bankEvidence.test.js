// Bank Balance and Unprocessed Bank from the extension's readings of Xero's Bank accounts page (bankEvidence.js),
// and their recalculation into stored checks. The SQLite part runs on a throwaway file and the MySQL pool is
// replaced by one that throws, so nothing here can reach the shared database. All names and figures are made up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akrio-bank-evidence-'));
process.env.XERO_DASHBOARD_DB_PATH = path.join(dir, 'test.db');
const poolPath = require.resolve('../src/db/mysqlPool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: { getPool: () => { throw new Error('MySQL is not available in this test'); } },
};

const { buildBankEvidence, loadLatestBankScreenReading, syntheticAccountId, screenItemCount, NEEDS_BANK_UPDATE } = require('../src/services/bankEvidence');
const { resolveCheckDisplayStatus, resolvePeriodChecked } = require('../src/services/checkRules');
const { calculateScoreBreakdown } = require('../src/services/scoreProfile');
const queries = require('../src/db/queries');
const { getDb } = require('../src/db/schema');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const NOW = new Date('2026-11-20T12:00:00Z');
const rec = (id, name, xero, extra = {}) => ({ bank_account_id: id, bank_account_name: name, xero_calculated_balance: xero, xero_balance_as_of: '2026-11-30', statement_balance: null, statement_balance_updated_at: null, ...extra });
const screen = (name, extra = {}) => ({
  accountName: name, accountNumber: null, itemsToReconcile: 0, reconciled: false, balancesDiffer: false,
  balanceInXero: 100, statementBalance: 100, statementDateLabel: 'Nov 20', feedProblem: false, stoppedImporting: false, noFeed: false, ...extra,
});
const reading = (accounts, readAt = new Date('2026-11-20T09:00:00Z')) => ({ batchId: 7, readAt, readByName: 'Test Person', accounts });

// ---- Bank Balance ----

test('screen evidence compares statement balance with balance in Xero from the same reading', () => {
  const result = buildBankEvidence({
    reconciliation: [rec('A', 'Current Account', 999)], // the report figure is ignored for screen evidence
    reading: reading([screen('Current Account', { statementBalance: 718.06, balanceInXero: -326.19 })]), now: NOW,
  });
  assert.equal(result.bankBalance.count, 1);
  assert.equal(result.bankBalance.findings[0].accountId, 'A');
  assert.equal(result.bankBalance.findings[0].difference, 1044.25);
  assert.equal(result.bankBalance.findings[0].discrepancy, 1044.25);
  assert.equal(result.bankBalance.findings[0].evidenceSource, 'Xero Bank accounts screen');
  assert.equal(result.bankBalance.findings[0].readByName, 'Test Person');
  assert.equal(Math.round(result.bankBalance.value * 100), 104425);
  assert.match(result.bankBalance.label, /^statement_comparison_as_of_2026-11-20$/);
});

test('an imported statement beats a typed balance, and a typed balance beats the screen', () => {
  const result = buildBankEvidence({
    reconciliation: [rec('A', 'Alpha', 50, { statement_balance: 40, statement_balance_updated_at: '2026-11-19 10:00:00' }), rec('B', 'Beta', 70, { statement_balance: 70, statement_balance_updated_at: '2026-11-19 10:00:00' })],
    imports: [{ bank_account_id: 'A', bank_account_name: 'Alpha', closing_balance: 55, statement_end_date: '2026-11-18' }],
    reading: reading([screen('Alpha', { statementBalance: 1, balanceInXero: 2 }), screen('Beta', { statementBalance: 3, balanceInXero: 4 })]), now: NOW,
  });
  const byId = Object.fromEntries(result.bankBalance.findings.map(item => [item.accountId, item]));
  assert.equal(byId.A.evidenceSource, 'CSV statement');
  assert.equal(byId.A.statementBalance, 55);
  assert.equal(byId.A.xeroBalance, 50);
  assert.equal(byId.B, undefined); // typed 70 vs Xero 70: no difference, and the screen's 3 vs 4 is not used
  assert.equal(result.bankBalance.count, 1);
  const cardB = result.accounts.find(card => card.accountId === 'B');
  assert.equal(cardB.evidenceSource, 'Manual closing balance');
  assert.equal(cardB.bankStatementBalance, 70);
  assert.equal(cardB.xeroStatementBalance, 3); // still shown for reference
});

test('one penny is rounding, two pence is a difference', () => {
  const result = buildBankEvidence({
    reading: reading([
      screen('Zero', { statementBalance: 10, balanceInXero: 10 }),
      screen('One', { statementBalance: 10.01, balanceInXero: 10 }),
      screen('Two', { statementBalance: 0.1 + 0.2, balanceInXero: 0.28 }),
    ]), now: NOW,
  });
  assert.deepEqual(result.bankBalance.findings.map(item => item.name), ['Two']);
  assert.equal(result.bankBalance.findings[0].discrepancy, 0.02);
  const all = buildBankEvidence({ reading: reading([screen('Zero'), screen('One', { statementBalance: 100.01 })]), now: NOW });
  assert.equal(all.bankBalance.count, 0);
  assert.match(all.bankBalance.label, /^statement_comparison_as_of_/);
});

test('account names match trimmed and case-insensitively; excluded accounts are left out', () => {
  const result = buildBankEvidence({
    reconciliation: [rec('A', 'Main  Account', 0), rec('B', 'Savings', 0)],
    excludedBankAccountIds: new Set(['B']),
    reading: reading([screen('  main account ', { statementBalance: 5, balanceInXero: 0 }), screen('SAVINGS', { statementBalance: 9, balanceInXero: 0, itemsToReconcile: 4 })]),
    now: NOW,
  });
  assert.deepEqual(result.bankBalance.findings.map(item => item.accountId), ['A']);
  assert.equal(result.unprocessed.count, 0);
  assert.equal(result.accounts.find(card => card.accountId === 'B').excluded, true);
});

test('an account Verify does not know keeps a stable id from its name and cannot be edited', () => {
  const first = buildBankEvidence({ reading: reading([screen('Other'), screen('PayPal GBP', { statementBalance: 1, balanceInXero: 0 })]), now: NOW });
  const second = buildBankEvidence({ reading: { ...reading([screen('paypal gbp', { statementBalance: 1, balanceInXero: 0 })]), batchId: 99 }, now: NOW });
  assert.equal(first.bankBalance.findings[0].accountId, syntheticAccountId('PayPal GBP'));
  assert.equal(first.bankBalance.findings[0].accountId, second.bankBalance.findings[0].accountId);
  assert.match(first.bankBalance.findings[0].accountId, /^screen:[0-9a-f]{16}$/);
  assert.equal(first.accounts.find(card => card.name === 'PayPal GBP').canEdit, false);
});

test('accounts without a feed balance are not compared, and a missing ledger figure is never zero', () => {
  const noFeed = buildBankEvidence({ reading: reading([screen('Cash', { statementBalance: null, balanceInXero: 50, noFeed: true })]), now: NOW });
  assert.equal(noFeed.bankBalance.count, null);
  assert.equal(noFeed.bankBalance.label, 'not_configured');
  const typedNoLedger = buildBankEvidence({ reconciliation: [rec('A', 'Alpha', null, { statement_balance: 10 })], now: NOW });
  assert.equal(typedNoLedger.bankBalance.label, 'needs_sync');
  assert.equal(typedNoLedger.bankBalance.count, null);
});

test('a reading exactly 7 days old is used; a moment older it is stale and never reports a pass', () => {
  const sevenDays = new Date(NOW.getTime() - 7 * 86400000);
  const fresh = buildBankEvidence({ reading: reading([screen('Alpha')], sevenDays), now: NOW });
  assert.equal(fresh.bankBalance.count, 0);
  const stale = buildBankEvidence({ reading: reading([screen('Alpha')], new Date(sevenDays.getTime() - 1)), now: NOW });
  assert.equal(stale.bankBalance.count, null);
  assert.equal(stale.bankBalance.label, NEEDS_BANK_UPDATE);
  assert.equal(stale.unprocessed.count, null);
  assert.equal(stale.unprocessed.label, NEEDS_BANK_UPDATE);
  assert.equal(stale.reading.usable, false);
  const unknownTime = buildBankEvidence({ reading: reading([screen('Alpha')], 'not a date'), now: NOW });
  assert.equal(unknownTime.bankBalance.count, null);
  const none = buildBankEvidence({ now: NOW });
  assert.equal(none.bankBalance.label, 'not_configured');
  assert.equal(none.unprocessed.label, 'not_configured');
});

test('a stale reading does not hide an imported statement or typed balance', () => {
  const result = buildBankEvidence({
    reconciliation: [rec('A', 'Alpha', 100, { statement_balance: 90, statement_balance_updated_at: '2026-11-19 10:00:00' })],
    reading: reading([screen('Alpha', { itemsToReconcile: 3 })], new Date('2026-10-01T00:00:00Z')), now: NOW,
  });
  assert.equal(result.bankBalance.count, 1);
  assert.equal(result.bankBalance.findings[0].evidenceSource, 'Manual closing balance');
});

// ---- Unprocessed Bank ----

test('screen counts: one finding per account with items, Reconciled counts as zero, unknown is skipped', () => {
  assert.equal(screenItemCount({ itemsToReconcile: null, reconciled: true }), 0);
  assert.equal(screenItemCount({ itemsToReconcile: null, reconciled: false }), null);
  const result = buildBankEvidence({
    reading: reading([
      screen('PayPal', { itemsToReconcile: 454, statementDateLabel: 'Nov 20' }),
      screen('Card', { itemsToReconcile: 67, feedProblem: true }),
      screen('Stripe', { itemsToReconcile: null, reconciled: true }),
      screen('Unknown', { itemsToReconcile: null }),
    ]), now: NOW,
  });
  assert.equal(result.unprocessed.count, 2);
  assert.equal(result.unprocessed.screenItems, 521);
  assert.equal(result.unprocessed.value, 0);
  assert.equal(result.unprocessed.label, 'bank_screen_2026-11-20');
  const card = result.unprocessed.findings.find(item => item.account === 'Card');
  assert.equal(card.itemsToReconcile, 67);
  assert.equal(card.bankFeed, 'Feed problem');
  assert.equal(card.statementDate, 'Nov 20'); // as Xero shows it, no year added
  assert.match(card.lastRead, /20 Nov 2026.*by Test Person/);
  assert.equal(card.accountId, undefined); // own identity, so it never collides with a statement line's account
  const clean = buildBankEvidence({ reading: reading([screen('Stripe', { itemsToReconcile: null, reconciled: true })]), now: NOW });
  assert.equal(clean.unprocessed.count, 0);
  const unknownOnly = buildBankEvidence({ reading: reading([screen('Unknown', { itemsToReconcile: null })]), now: NOW });
  assert.equal(unknownOnly.unprocessed.count, null);
  assert.equal(unknownOnly.unprocessed.label, NEEDS_BANK_UPDATE);
});

test('an account with an imported statement uses its lines; other accounts use the screen', () => {
  const lines = [
    { statementLineId: 1, accountId: 'A', account: 'Alpha', amount: -10 },
    { statementLineId: 2, accountId: 'A', account: 'Alpha', amount: 20 },
  ];
  const result = buildBankEvidence({
    reconciliation: [rec('A', 'Alpha', 0), rec('B', 'Beta', 0)],
    imports: [{ bank_account_id: 'A', bank_account_name: 'Alpha', closing_balance: 0, statement_end_date: '2026-11-15' }],
    unmatchedLines: lines,
    reading: reading([screen('Alpha', { itemsToReconcile: 50 }), screen('Beta', { itemsToReconcile: 7 })]), now: NOW,
  });
  assert.equal(result.unprocessed.count, 3);
  assert.equal(result.unprocessed.value, 30);
  assert.equal(result.unprocessed.screenItems, 7);
  assert.equal(result.unprocessed.findings.length, 3);
  assert.match(result.unprocessed.label, /^imported_statements_2026-11-15$/);
});

test('a reading that cannot be loaded behaves as no reading and is logged', async () => {
  const logged = [];
  const result = await loadLatestBankScreenReading(5, {
    getLatestBankScreenReading: async () => { throw new Error('connect ETIMEDOUT'); },
    logger: { error: (...args) => logged.push(args.join(' ')) },
  });
  assert.equal(result, null);
  assert.ok(logged[0].includes('org 5') && logged[0].includes('ETIMEDOUT'));
  assert.equal(await loadLatestBankScreenReading(5, { getLatestBankScreenReading: async () => undefined }), null);
});

// ---- status, scoring and storage ----

test('needs_bank_update is a set-up state: kept as is, shown as not configured, not scored', () => {
  assert.equal(resolvePeriodChecked(NEEDS_BANK_UPDATE, 'since_lock_date:2025-10-31:2026-11-30'), NEEDS_BANK_UPDATE);
  assert.equal(resolveCheckDisplayStatus({ period_checked: NEEDS_BANK_UPDATE, count: null }), 'not_configured');
  const breakdown = calculateScoreBreakdown([
    { check_type: 'bank_balance', importance: 'critical', period_checked: NEEDS_BANK_UPDATE, count: null, potential_value_gbp: 0 },
    // even with old findings still attached, a stale-reading check takes nothing off the score
    { check_type: 'unprocessed_bank', importance: 'critical', period_checked: NEEDS_BANK_UPDATE, count: 3, potential_value_gbp: 0, findings: [{ itemsToReconcile: 3 }] },
  ]);
  assert.equal(breakdown.totalDeduction, 0);
  assert.deepEqual(breakdown.observations.map(item => item.excludedReason), [NEEDS_BANK_UPDATE, NEEDS_BANK_UPDATE]);
});

test('recalculating stores both checks from a fresh reading, and the item total follows dismissals', async () => {
  const ORG = 77;
  getDb();
  queries.upsertBankReconciliationXeroBalance(ORG, 'acc-1', 'Current Account', 500, '2026-11-30');
  queries.upsertBankReconciliationXeroBalance(ORG, 'acc-2', 'Card', -20, '2026-11-30');
  const originalOrg = queries.getOrganisationById;
  queries.getOrganisationById = async id => ({ id, name: 'Synthetic Ltd' });
  const { recomputeEvidenceIssues } = require('../src/services/statementEvidence');
  try {
    await recomputeEvidenceIssues(ORG, 'since_lock_date:2025-10-31:2026-11-30', null, {
      deferScoreRefresh: true, now: NOW,
      getLatestBankScreenReading: async () => reading([
        screen('Current Account', { statementBalance: 520, balanceInXero: 500, itemsToReconcile: 12 }),
        screen('Card', { statementBalance: -20, balanceInXero: -20, itemsToReconcile: 3 }),
      ]),
    });
    const balance = queries.getIssueByCheckType(ORG, 'bank_balance');
    assert.equal(balance.count, 1);
    assert.equal(Math.round(balance.potential_value_gbp * 100), 2000);
    assert.equal(resolveCheckDisplayStatus(balance), 'issues');
    const unprocessed = queries.getIssueByCheckType(ORG, 'unprocessed_bank');
    assert.equal(unprocessed.count, 2);
    assert.equal(unprocessed.potential_value_gbp, 0);
    assert.equal(queries.getLiveScreenItemTotal(unprocessed.id), 15);
    // Dismiss the Card row: one account and three items fewer.
    const findings = queries.getIssueFindings(unprocessed.id, ORG, 1, 50, 'active', '', 'any').items;
    const cardKey = findings.find(item => item.account === 'Card').finding_key;
    getDb().prepare(`INSERT INTO finding_review_states (org_id, check_type, finding_key, state) VALUES (?, 'unprocessed_bank', ?, 'dismissed')`).run(ORG, cardKey);
    assert.equal(queries.getIssueByCheckType(ORG, 'unprocessed_bank').count, 1);
    assert.equal(queries.getLiveScreenItemTotal(unprocessed.id), 12);

    // A week later with no new reading: both checks need a fresh reading, not a pass.
    await recomputeEvidenceIssues(ORG, 'since_lock_date:2025-10-31:2026-11-30', null, {
      deferScoreRefresh: true, now: new Date('2026-11-28T12:00:00Z'),
      getLatestBankScreenReading: async () => reading([screen('Current Account')]),
    });
    assert.equal(queries.getIssueByCheckType(ORG, 'bank_balance').period_checked, NEEDS_BANK_UPDATE);
    assert.equal(queries.getIssueByCheckType(ORG, 'bank_balance').count, null);
    assert.equal(queries.getIssueByCheckType(ORG, 'unprocessed_bank').period_checked, NEEDS_BANK_UPDATE);

    // Another organisation's checks are untouched.
    assert.equal(queries.getIssueByCheckType(ORG + 1, 'bank_balance'), undefined);
  } finally {
    queries.getOrganisationById = originalOrg;
  }
});

test('a recalculation with no period given uses the period the sync stored on Unreconciled Bank', async () => {
  const ORG = 78;
  const PERIOD = 'since_lock_date:2025-10-31:2026-11-30';
  getDb();
  queries.upsertBankReconciliationXeroBalance(ORG, 'acc-1', 'Current Account', 500, '2026-11-30');
  queries.insertIssue({ org_id: ORG, check_type: 'unreconciled_bank_items', importance: 'critical', count: 0, potential_value_gbp: 0, detail_json: '[]', period_checked: PERIOD });
  const originalOrg = queries.getOrganisationById;
  queries.getOrganisationById = async id => ({ id, name: 'Synthetic Ltd' });
  const { recomputeEvidenceIssues } = require('../src/services/statementEvidence');
  try {
    await recomputeEvidenceIssues(ORG, null, null, {
      deferScoreRefresh: true, now: NOW,
      getLatestBankScreenReading: async () => reading([screen('Current Account', { statementBalance: 510, balanceInXero: 500, itemsToReconcile: 2 })]),
    });
    assert.equal(queries.getIssueByCheckType(ORG, 'bank_balance').period_checked, PERIOD);
    assert.equal(queries.getIssueByCheckType(ORG, 'unprocessed_bank').period_checked, PERIOD);
  } finally {
    queries.getOrganisationById = originalOrg;
  }
});
