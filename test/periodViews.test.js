// Period views: the health checks worked out for another period are kept BESIDE the client's normal results.
// Looking at another period must never change the normal ones; the next real sync clears the views.
// Throwaway SQLite; MySQL is replaced by a stand-in that accepts every query. Made-up data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akrio-period-views-'));
process.env.XERO_DASHBOARD_DB_PATH = path.join(dir, 'test.db');
const poolPath = require.resolve('../src/db/mysqlPool');
const fakePool = { query: async () => [[], []], getConnection: async () => ({ query: async () => [[], []], beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} }) };
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => fakePool } };

const queries = require('../src/db/queries');
const { getDb } = require('../src/db/schema');
const { isNormalPeriod, resolvePeriod } = require('../src/services/periodResolver');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const finding = n => ({ invoiceId: 'inv-' + n, number: 'INV-' + n, date: '2026-10-0' + (1 + (n % 9)), amount: 10 * n, contact: 'Contact ' + n });
const issue = (orgId, type, runId, active, findings, period) => ({
  org_id: orgId, check_type: type, importance: 'medium', count: findings.length,
  potential_value_gbp: findings.reduce((sum, f) => sum + f.amount, 0), detail_json: JSON.stringify(findings),
  period_checked: period, run_id: runId, is_active: active,
});
const NORMAL = 'since_lock_date:2025-04-30:2026-11-21';
const OCTOBER = 'previous_month:2026-10-01:2026-10-31';
const counts = (orgId, runId, active, period) => queries.upsertTransactionCounts(orgId, { period: period.split(':')[0], period_start: period.split(':')[1], period_end: period.split(':')[2], months_covered: 1, turnover: 0, total_transactions: 0, customer_invoices: 0, supplier_bills: 0, credit_notes_sales: 0, credit_notes_purchase: 0, bank_processed: 0, journals: 0, run_id: runId, is_active: active });

function seed(orgId) {
  getDb();
  // the client's normal results (run 10, active)
  queries.insertIssue(issue(orgId, 'old_unpaid_invoices', 10, 1, [finding(1), finding(2), finding(3)], NORMAL));
  queries.insertIssue(issue(orgId, 'duplicate_bills', 10, 1, [finding(4)], NORMAL));
  queries.insertIssue(issue(orgId, 'suspense_open_balance', 10, 1, [finding(5)], NORMAL)); // needs a live Xero report
  counts(orgId, 10, 1, NORMAL);
  // a view of October (run 20, staged, never activated)
  queries.insertIssue(issue(orgId, 'old_unpaid_invoices', 20, 0, [finding(1)], OCTOBER));
  queries.insertIssue(issue(orgId, 'duplicate_bills', 20, 0, [], OCTOBER));
  counts(orgId, 20, 0, OCTOBER);
  queries.registerPeriodView(orgId, OCTOBER, 20, { preservedTypes: ['suspense_open_balance'], summary: { periodLabel: 'Previous month' } });
}
const liveState = orgId => queries.getIssuesForOrg(orgId).map(i => [i.check_type, i.count, i.period_checked, i.run_id]).sort();

test('a view sits beside the normal results and never changes them', () => {
  seed(1);
  const before = liveState(1);
  assert.deepEqual(before.map(row => row[1]), [1, 3, 1]);
  const view = queries.getPeriodView(1, OCTOBER);
  assert.equal(view.runId, 20);
  assert.equal(view.baseRunId, 10);
  const viewed = Object.fromEntries(queries.getIssuesForView(view).map(i => [i.check_type, i]));
  assert.equal(viewed.old_unpaid_invoices.count, 1);
  assert.equal(viewed.old_unpaid_invoices.period_checked, OCTOBER);
  assert.equal(viewed.duplicate_bills.count, 0);
  // a check a stored-data recalculation cannot produce keeps its normal result inside the view
  assert.equal(viewed.suspense_open_balance.count, 1);
  assert.equal(viewed.suspense_open_balance.run_id, 10);
  assert.equal(queries.getIssueByCheckTypeForView(view, 'old_unpaid_invoices').run_id, 20);
  assert.equal(queries.getIssueByCheckTypeForView(view, 'suspense_open_balance').run_id, 10);
  assert.equal(queries.getIssueByCheckTypeForView(view, 'never_ran'), undefined);
  assert.deepEqual(liveState(1), before, 'the normal results are exactly as they were');
  assert.equal(queries.getPeriodView(1, 'current_month:2026-11-01:2026-11-21'), null);
  assert.equal(queries.getPeriodView(2, OCTOBER), null, 'another client has no view');
});

test('a review made in a view applies to the view\'s findings; the normal results keep their own', async () => {
  seed(3);
  const view = queries.getPeriodView(3, OCTOBER);
  const viewIssue = queries.getIssueByCheckTypeForView(view, 'old_unpaid_invoices');
  const key = queries.getIssueFindings(viewIssue.id, 3, 1, 50, 'active', '', 'any').items[0].finding_key;
  await queries.setFindingReviewStates(3, 'old_unpaid_invoices', [key], 'dismissed', null, { viewRunId: view.runId });
  assert.equal(queries.getIssueByCheckTypeForView(view, 'old_unpaid_invoices').count, 0);
  // The same invoice is also in the normal period: a dismissal is remembered per finding, so it shows there too.
  assert.equal(queries.getIssueByCheckType(3, 'old_unpaid_invoices').count, 2);
  await queries.setFindingReviewStates(3, 'old_unpaid_invoices', [key], 'restore', null, { viewRunId: view.runId });
  assert.equal(queries.getIssueByCheckTypeForView(view, 'old_unpaid_invoices').count, 1);
  assert.equal(queries.getIssueByCheckType(3, 'old_unpaid_invoices').count, 3);
});

test('the next real sync clears the views and their rows; older normal rows are untouched', () => {
  seed(4);
  const db = getDb();
  const rowsOf = runId => db.prepare(`SELECT COUNT(*) AS n FROM issues WHERE org_id = 4 AND run_id = ?`).get(runId).n;
  assert.equal(rowsOf(20), 2);
  // a new normal run (30) is staged and activated
  queries.insertIssue(issue(4, 'old_unpaid_invoices', 30, 0, [finding(1), finding(2)], NORMAL));
  counts(4, 30, 0, NORMAL);
  queries.activateSqliteResults(db, 4, 30);
  assert.equal(queries.getPeriodView(4, OCTOBER), null);
  assert.equal(rowsOf(20), 0, 'the view\'s rows are gone');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM issue_findings WHERE org_id = 4 AND run_id = 20`).get().n, 0);
  assert.equal(rowsOf(10), 3, 'the previous normal run\'s rows are history, not deleted');
  assert.deepEqual(liveState(4), [['old_unpaid_invoices', 2, NORMAL, 30]]);
});

test('a view built on an older normal run is treated as out of date', () => {
  seed(5);
  getDb().prepare(`UPDATE period_views SET base_run_id = 9 WHERE org_id = 5`).run();
  assert.equal(queries.getPeriodView(5, OCTOBER), null);
});

test('rebuilding a view replaces it, and only the newest three views of a client are kept', () => {
  seed(6);
  const db = getDb();
  queries.insertIssue(issue(6, 'old_unpaid_invoices', 21, 0, [finding(1), finding(2)], OCTOBER));
  queries.registerPeriodView(6, OCTOBER, 21, {});
  assert.equal(queries.getPeriodView(6, OCTOBER).runId, 21);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM issues WHERE org_id = 6 AND run_id = 20`).get().n, 0, 'the earlier view\'s rows are removed');
  for (const [key, run] of [['current_month:2026-11-01:2026-11-21', 22], ['rolling_12_months:2025-11-22:2026-11-21', 23], ['custom:2026-07-01:2026-09-30', 24]]) {
    queries.insertIssue(issue(6, 'old_unpaid_invoices', run, 0, [finding(1)], key));
    queries.registerPeriodView(6, key, run, {});
    db.prepare(`UPDATE period_views SET built_at = datetime('now', '+' || ? || ' seconds') WHERE org_id = 6 AND run_id = ?`).run(run, run);
  }
  queries.insertIssue(issue(6, 'old_unpaid_invoices', 25, 0, [finding(1)], 'current_fy:2026-05-01:2026-11-21'));
  queries.registerPeriodView(6, 'current_fy:2026-05-01:2026-11-21', 25, {});
  const kept = db.prepare(`SELECT run_id FROM period_views WHERE org_id = 6`).all().map(r => r.run_id).sort();
  assert.equal(kept.length, 3);
  assert.ok(!kept.includes(21), 'the oldest view was dropped');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM issues WHERE org_id = 6 AND run_id = 21`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM issues WHERE org_id = 6 AND is_active = 1`).get().n, 3, 'active rows are never deleted by view clean-up');
});

test('the normal period is decided by its kind, not by today\'s date in its key', () => {
  const org = { period_key: 'since_lock_date:2025-04-30:2026-11-20', period_type: 'since_lock_date', period_start: '2025-04-30', period_end: '2026-11-20' };
  const context = { asOf: '2026-11-21', lockDate: '2025-04-30' };
  assert.equal(isNormalPeriod(org, resolvePeriod({ type: 'since_lock_date' }, context)), true, 'same kind on a later day is still the normal period');
  assert.equal(isNormalPeriod(org, resolvePeriod({ type: 'previous_month' }, context)), false);
  assert.equal(isNormalPeriod(org, resolvePeriod({ type: 'custom', from: '2026-07-01', to: '2026-09-30' }, context)), false);
  const customOrg = { period_key: 'custom:2026-07-01:2026-09-30', period_type: 'custom', period_start: '2026-07-01', period_end: '2026-09-30' };
  assert.equal(isNormalPeriod(customOrg, resolvePeriod({ type: 'custom', from: '2026-07-01', to: '2026-09-30' }, context)), true);
  assert.equal(isNormalPeriod(customOrg, resolvePeriod({ type: 'custom', from: '2026-07-01', to: '2026-08-31' }, context)), false);
  assert.equal(isNormalPeriod({ period_key: null }, resolvePeriod({ type: 'previous_month' }, context)), true, 'never synced: nothing to view beside');
});

// ---- the check page keeps the viewed period in every link and form ----
test('check page in a period view: links, filter form, review and note forms all carry the period', async () => {
  const ejs = require('ejs');
  const { groupSupplierTransactions } = require('../src/services/checkPresentation');
  const items = [{ finding_key: 'k1', number: 'INV-1', contact: 'A', amount: 10, date: '2026-10-02', review_state: 'active', xero_links: [], standaloneNote: null }];
  const locals = {
    basePath: '/akrio-verify', csrfToken: 'token', org: { name: 'Synthetic Ltd', id: 1, xero_tenant_id: 'synthetic-org' },
    issue: { count: 1, potential_value_gbp: 10, period_checked: OCTOBER }, def: { type: 'old_unpaid_invoices', label: 'Old Unpaid Invoices', importance: 'medium' },
    items, pagination: { page: 2, totalPages: 3, total: 120, items }, summary: { active: 1, dismissed: 0, ignored: 0, ok: 0 },
    status: 'active', contact: '', checkType: 'old_unpaid_invoices', checkDescriptions: {}, groupSupplierTransactions,
    practiceName: 'P', cssVersion: 't', staffName: null, staffRole: null, isStaffManager: false, canAccessSettings: false,
  };
  const file = path.join(__dirname, '../src/views/checkDetail.ejs');
  const viewed = await ejs.renderFile(file, { ...locals, viewQuery: 'period=custom&from=2026-07-01&to=2026-09-30', periodView: { label: 'Custom (2026-07-01 to 2026-09-30)', normalLabel: 'Since lock date (2025-04-30)' } });
  assert.match(viewed, /Viewing Custom \(2026-07-01 to 2026-09-30\)\./);
  assert.match(viewed, /normal results \(Since lock date \(2025-04-30\)\) are unchanged/);
  assert.match(viewed, /href="\?status=active&amp;period=custom&amp;from=2026-07-01&amp;to=2026-09-30"|href="\?status=active&period=custom&from=2026-07-01&to=2026-09-30"/);
  assert.match(viewed, /page=3[^"]*period=custom/, 'the Next link stays in the period');
  assert.match(viewed, /export\.csv\?status=active[^"]*period=custom/);
  assert.ok((viewed.match(/name="period" value="custom"/g) || []).length >= 4, 'filter, bulk, review and note forms carry the period');
  assert.ok((viewed.match(/name="from" value="2026-07-01"/g) || []).length >= 4);
  const normal = await ejs.renderFile(file, locals);
  assert.doesNotMatch(normal, /name="period"/);
  assert.doesNotMatch(normal, /Viewing /);
});
