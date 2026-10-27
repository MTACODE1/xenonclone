// Accountant's answers of 26 Oct 2026: every review-period check also lists the previous 3 months, separately and
// never counted; Old Unpaid Bills aged as at month end; capital defaults; £0 bank transactions not counted.
// The SQLite part runs on a throwaway file and the MySQL pool is replaced by one that throws, so nothing here can reach
// the shared database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akrio-previous-months-'));
process.env.XERO_DASHBOARD_DB_PATH = path.join(dir, 'test.db');
const poolPath = require.resolve('../src/db/mysqlPool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: { getPool: () => { throw new Error('MySQL is not available in this test'); } },
};

const {
  previousMonthsStart, isWithinPreviousMonths, withPreviousMonths, endOfMonth, countsAsBankProcessed,
  isCapitalDefaultAccount, resolveCapitalReviewCandidateCodes, isOverdueMoreThan, PRACTICE_POLICY,
} = require('../src/services/checkRules');
const { resolvePeriod } = require('../src/services/periodResolver');
const { getDb } = require('../src/db/schema');
const {
  insertIssue, getIssueFindings, getIssueFindingSummary, getAllFindingKeysForIssue, getReportFindings,
} = require('../src/db/queries');
const { groupSupplierTransactions } = require('../src/services/checkPresentation');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ---- the previous-3-months window ----

test('the window starts 3 calendar months before the period start', () => {
  assert.equal(PRACTICE_POLICY.previousMonthsShown, 3);
  assert.equal(previousMonthsStart({ start: '2025-10-01' }), '2025-07-01');
  assert.equal(previousMonthsStart({ start: '2026-01-15' }), '2025-10-15');
});

test('a day that does not exist 3 months earlier falls back to that month\'s last day', () => {
  assert.equal(previousMonthsStart({ start: '2026-05-31' }), '2026-02-28');
  assert.equal(previousMonthsStart({ start: '2024-05-31' }), '2024-02-29');
  assert.equal(previousMonthsStart({ start: '2026-12-31' }), '2026-09-30');
});

test('no period start, no window', () => {
  assert.equal(previousMonthsStart({ start: null }), null);
  assert.equal(previousMonthsStart({}), null);
  assert.equal(isWithinPreviousMonths('2026-01-01', { start: null }, null), false);
});

test('since-lock-date period: the lock date itself is not in the period, so it is in the previous months', () => {
  const period = resolvePeriod({}, { lockDate: '2025-09-30', asOf: '2026-10-27' });
  const start = previousMonthsStart(period);
  assert.equal(start, '2025-06-30');
  assert.equal(isWithinPreviousMonths('2025-09-30', period, start), true, 'the lock date');
  assert.equal(isWithinPreviousMonths('2025-10-01', period, start), false, 'first day of the review period');
  assert.equal(isWithinPreviousMonths('2025-06-30', period, start), true, 'first day of the window');
  assert.equal(isWithinPreviousMonths('2025-06-29', period, start), false, 'before the window');
  assert.equal(isWithinPreviousMonths('2026-11-01', period, start), false, 'after the period');
  assert.equal(isWithinPreviousMonths(null, period, start), false);
});

test('custom period: the start day is in the period, so the window ends the day before', () => {
  const period = resolvePeriod({ type: 'custom', from: '2025-10-01', to: '2026-09-30' }, { asOf: '2026-10-27' });
  const start = previousMonthsStart(period);
  assert.equal(start, '2025-07-01');
  assert.equal(isWithinPreviousMonths('2025-10-01', period, start), false);
  assert.equal(isWithinPreviousMonths('2025-09-30', period, start), true);
  assert.equal(isWithinPreviousMonths('2025-07-01', period, start), true);
});

test('previous-months rows go after the counted rows, display only and labelled', () => {
  const counted = [{ invoiceId: 'a', amount: 10 }];
  const rows = withPreviousMonths(counted, [{ invoiceId: 'b', amount: 5 }]);
  assert.deepEqual(rows[0], counted[0], 'the counted row is untouched');
  assert.deepEqual(rows[1], { invoiceId: 'b', amount: 5, inPeriod: false, lookback: true, displayOnly: true });
  assert.deepEqual(withPreviousMonths(counted, undefined), counted);
});

// ---- Old Unpaid Bills: aged as at month end ----

test('a bill due 25 Aug is over 60 days overdue at the end of October, not on 22 Oct', () => {
  const bill = { dueDate: '2026-08-25', date: '2026-07-25' };
  assert.equal(isOverdueMoreThan(bill, new Date('2026-10-22T00:00:00.000Z')), false, '58 days on 22 Oct');
  assert.equal(endOfMonth('2026-10-22'), '2026-10-31');
  assert.equal(isOverdueMoreThan(bill, new Date(`${endOfMonth('2026-10-22')}T00:00:00.000Z`)), true, '67 days on 31 Oct');
});

test('end of month', () => {
  assert.equal(endOfMonth('2026-09-30'), '2026-09-30', 'a period ending on a month end is unchanged');
  assert.equal(endOfMonth('2024-02-10'), '2024-02-29');
  assert.equal(endOfMonth('2026-02-10'), '2026-02-28');
  assert.equal(endOfMonth('2026-12-01'), '2026-12-31');
});

// ---- Bank Processed ----

test('a £0.00 bank transaction is not counted as processed', () => {
  assert.equal(countsAsBankProcessed({ total: 0 }), false);
  assert.equal(countsAsBankProcessed({ total: 0.004 }), false);
  assert.equal(countsAsBankProcessed({ total: null }), false);
  assert.equal(countsAsBankProcessed({ total: 0.01 }), true, 'a 1p rounding posting is still a transaction');
  assert.equal(countsAsBankProcessed({ total: -12.5 }), true);
});

// ---- Capital Item Review defaults ----

test('every expense-type account is watched by default', () => {
  for (const type of ['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS']) {
    assert.equal(isCapitalDefaultAccount({ type, name: 'Repairs and Maintenance' }), true, type);
  }
  for (const type of ['DEPRECIATN', 'REVENUE', 'FIXED', 'CURRLIAB', 'BANK', undefined]) {
    assert.equal(isCapitalDefaultAccount({ type, name: 'Computer Equipment' }), false, String(type));
  }
});

test('wages, rent, rates, insurance, interest, depreciation and tax are left out', () => {
  for (const name of [
    'Wages and Salaries', 'Wages', 'Salaries', 'Directors\' Remuneration', 'Employers National Insurance', 'Employer NI',
    'Pensions', 'Payroll costs', 'Rent', 'Rent and Rates', 'Office Rental', 'Business Rates', 'Council Tax',
    'Insurance', 'Motor Insurance', 'Loan Interest', 'Interest Paid', 'Bank Interest', 'Depreciation',
    'Amortisation', 'Corporation Tax', 'Tax', 'VAT', 'Taxation',
  ]) assert.equal(isCapitalDefaultAccount({ type: 'OVERHEADS', name }), false, name);
});

test('word boundaries: similar words are not mistaken for an excluded one', () => {
  for (const name of [
    'Current Projects', 'Parent Company Recharges', 'Corporate Entertainment', 'Taxi Fares', 'Printing & Stationery',
    'Computer Equipment', 'Subscriptions', 'Tools and Equipment', 'Minor Equipment', 'Light, Power, Heating',
  ]) assert.equal(isCapitalDefaultAccount({ type: 'OVERHEADS', name }), true, name);
});

test('candidates are the practice default plus any ticked account', () => {
  const chart = [
    { code: '461', name: 'Printing & Stationery', type: 'OVERHEADS' },
    { code: '473', name: 'Repairs and Maintenance', type: 'OVERHEADS' },
    { code: '477', name: 'Wages and Salaries', type: 'OVERHEADS' },
    { code: '469', name: 'Rent', type: 'OVERHEADS' },
    { code: '416', name: 'Depreciation', type: 'DEPRECIATN' },
    { code: '200', name: 'Sales', type: 'REVENUE' },
    { code: '310', name: 'Cost of Goods Sold', type: 'DIRECTCOSTS' },
  ];
  const ticked = [{ account_code: '469', is_capital_candidate: 1 }, { account_code: '477', is_capital_candidate: 0 }];
  assert.deepEqual([...resolveCapitalReviewCandidateCodes(ticked, chart)].sort(), ['310', '461', '469', '473']);
  assert.equal(resolveCapitalReviewCandidateCodes([], [{ code: '200', name: 'Sales', type: 'REVENUE' }]).size, 0,
    'a chart with no eligible account stays "Not configured"');
});

// ---- storage: counted rows unchanged, previous-months rows kept apart ----

function seedIssue(checkType, counted, previous, potentialValue) {
  getDb().prepare(`INSERT OR IGNORE INTO organisations (id, xero_tenant_id, name) VALUES (1, 'tenant-1', 'Test')`).run();
  insertIssue({
    org_id: 1, check_type: checkType, importance: 'medium', count: counted.length,
    potential_value_gbp: potentialValue, detail_json: JSON.stringify(withPreviousMonths(counted, previous)),
    period_checked: 'since_lock_date',
  });
  return getDb().prepare(`SELECT * FROM issues WHERE org_id = 1 AND check_type = ? ORDER BY id DESC`).get(checkType);
}

const counted = [
  { invoiceId: 'inv-1', contact: 'Alpha', date: '2026-01-10', accountCode: '429', description: 'a', amount: 100 },
  { invoiceId: 'inv-2', contact: 'Beta', date: '2026-02-10', accountCode: '429', description: 'b', amount: 50 },
];
const previous = [
  { invoiceId: 'inv-0', contact: 'Alpha', date: '2025-09-10', accountCode: '429', description: 'c', amount: 999 },
  // Same identity as a counted row: the counted row keeps its key, this one gets the next occurrence.
  { invoiceId: 'inv-1', contact: 'Alpha', date: '2026-01-10', accountCode: '429', description: 'a', amount: 100 },
];

test('count and value come from the review period only', () => {
  const withRows = seedIssue('misallocated_items', counted, previous, 150);
  assert.equal(withRows.count, 2);
  assert.equal(withRows.potential_value_gbp, 150);
  const findings = getDb().prepare(`SELECT finding_key, display_only, potential_value_gbp FROM issue_findings WHERE issue_id = ? ORDER BY id`).all(withRows.id);
  assert.deepEqual(findings.map(f => f.display_only), [0, 0, 1, 1]);
  assert.deepEqual(findings.map(f => f.potential_value_gbp), [100, 50, 0, 0]);

  // The same counted rows stored without any previous-months rows get the same keys.
  const without = seedIssue('misallocated_items', counted, [], 150);
  const keysWithout = getDb().prepare(`SELECT finding_key FROM issue_findings WHERE issue_id = ? ORDER BY id`).all(without.id).map(r => r.finding_key);
  assert.deepEqual(findings.slice(0, 2).map(f => f.finding_key), keysWithout);
  assert.equal(new Set(findings.map(f => f.finding_key)).size, 4, 'no key collides');
});

test('a check with nothing in the period but rows in the previous months still counts 0', () => {
  const issue = seedIssue('unexpected_account_used', [], previous, 0);
  assert.equal(issue.count, 0);
  assert.equal(issue.potential_value_gbp, 0);
});

test('the check page lists the period and the previous months separately', () => {
  const issue = seedIssue('low_cost_fixed_assets', counted, previous, 150);
  const period = getIssueFindings(issue.id, 1, 1, 50, 'all', '');
  assert.equal(period.total, 2);
  assert.ok(period.items.every(item => !item.lookback));
  const earlier = getIssueFindings(issue.id, 1, 1, 50, 'all', '', 'previous');
  assert.equal(earlier.total, 2);
  assert.ok(earlier.items.every(item => item.lookback && item.displayOnly));
  assert.equal(getIssueFindings(issue.id, 1, 1, 50, 'all', '', 'any').total, 4, 'the CSV export takes both');
  assert.equal(getIssueFindings(issue.id, 1, 1, 50, 'all', 'Beta').total, 1, 'contact filter still applies');
});

test('the status tabs and "Ignore/Dismiss all N items" cover the review period only', () => {
  const issue = seedIssue('capital_item_review', counted, previous, 150);
  const summary = getIssueFindingSummary(issue.id, 1);
  assert.equal(summary.active, 2);
  assert.equal(summary.previous, 2);
  const keys = getAllFindingKeysForIssue(issue.id, 1, 'active');
  assert.equal(keys.length, 2);
});

test('the report lists review-period findings only', () => {
  const issue = seedIssue('undocumented_bills', counted, previous, 0);
  getDb().prepare(`UPDATE issue_findings SET is_active = 1 WHERE issue_id = ?`).run(issue.id);
  getDb().prepare(`UPDATE issues SET is_active = 0 WHERE org_id = 1 AND check_type = 'undocumented_bills' AND id <> ?`).run(issue.id);
  const report = getReportFindings(1, 50);
  const rows = report.undocumented_bills || [];
  assert.ok(rows.length > 0);
  assert.ok(rows.every(row => !row.lookback));
});

// ---- drill-down label ----

test('supplier drill-down: earlier lines keep their own labelled group', () => {
  const grouped = groupSupplierTransactions([{ inPeriod: true }, { inPeriod: false }]);
  assert.deepEqual(grouped.groups.map(g => g.key), ['period', 'earlier']);
  assert.match(grouped.groups[1].label, /earlier than the review period/i);
});
