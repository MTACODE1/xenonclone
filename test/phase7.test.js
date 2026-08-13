const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const ejs = require('ejs');

process.env.XERO_DASHBOARD_DB_PATH = path.join(os.tmpdir(), `xero-phase7-${process.pid}-${Date.now()}.db`);

const { resolvePeriod } = require('../src/services/periodResolver');
const { getDb } = require('../src/db/schema');
const {
  getIssueByCheckType, getPanoramaOrganisations, insertIssue, replaceIssueForCheck, upsertHealthScore,
} = require('../src/db/queries');

test('period resolver handles month, rolling year and UK-style financial-year boundaries', () => {
  assert.deepEqual(
    resolvePeriod({ type: 'previous_month' }, { asOf: '2026-01-15' }),
    {
      type: 'previous_month', start: '2025-12-01', end: '2025-12-31',
      key: 'previous_month:2025-12-01:2025-12-31',
      label: 'Previous month (2025-12-01 to 2025-12-31)',
      monthsCovered: 31 / (365.2425 / 12),
    }
  );
  const rolling = resolvePeriod({ type: 'rolling_12_months' }, { asOf: '2026-08-07' });
  assert.equal(rolling.start, '2025-08-08');
  assert.equal(rolling.end, '2026-08-07');
  const currentFy = resolvePeriod(
    { type: 'current_fy' },
    { asOf: '2026-04-01', financialYearEndMonth: 3, financialYearEndDay: 31 }
  );
  assert.equal(currentFy.start, '2026-04-01');
  assert.equal(currentFy.end, '2026-04-01');
  const previousFy = resolvePeriod(
    { type: 'previous_fy' },
    { asOf: '2026-03-31', financialYearEndMonth: 3, financialYearEndDay: 31 }
  );
  assert.equal(previousFy.start, '2024-04-01');
  assert.equal(previousFy.end, '2025-03-31');
});

test('custom periods reject malformed, reversed and future ranges', () => {
  assert.throws(() => resolvePeriod({ type: 'custom', from: 'bad', to: '2026-01-01' }, { asOf: '2026-08-07' }), /valid/);
  assert.throws(() => resolvePeriod({ type: 'custom', from: '2026-02-01', to: '2026-01-01' }, { asOf: '2026-08-07' }), /after/);
  assert.throws(() => resolvePeriod({ type: 'custom', from: '2026-01-01', to: '2027-01-01' }, { asOf: '2026-08-07' }), /future/);
});

test('panorama batches issue breakdown and per-check replacement preserves other checks', () => {
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('phase7', 'Phase Seven Ltd')
  `).run().lastInsertRowid);
  upsertHealthScore(orgId, {
    score: 90, total_issues: 2, total_potential_errors_gbp: 25,
    last_bank_reconciled: null, most_recent_transaction: '2026-08-01',
    unreconciled_bank_items: 0, lock_date: '2026-03-31',
    period_key: 'current_month:2026-08-01:2026-08-07',
  });
  const issue = type => ({
    org_id: orgId, check_type: type, importance: 'medium', count: 1,
    potential_value_gbp: 10, detail_json: JSON.stringify([{ id: type, amount: 10 }]),
    period_checked: 'current_month:2026-08-01:2026-08-07',
  });
  insertIssue(issue('unapproved_invoices'));
  insertIssue(issue('unapproved_bills'));
  replaceIssueForCheck({ ...issue('unapproved_invoices'), count: 0, potential_value_gbp: 0, detail_json: '[]' });
  assert.equal(getIssueByCheckType(orgId, 'unapproved_bills').count, 1);
  assert.equal(getIssueByCheckType(orgId, 'unapproved_invoices').count, 0);
  const panorama = getPanoramaOrganisations().find(row => row.id === orgId);
  assert.equal(panorama.issueBreakdown.length, 1);
  assert.equal(panorama.issueBreakdown[0].checkType, 'unapproved_bills');
});

test('dedicated report template renders period, checks and exclusion note', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../src/views/report.ejs'), {
    org: {
      name: 'Render Ltd', score: 82, total_issues: 1, total_potential_errors_gbp: 10,
      last_synced_at: '2026-08-07T10:00:00Z', calculated_at: '2026-08-07',
      most_recent_transaction: '2026-08-06', lock_date: '2026-03-31',
    },
    selectedPeriod: {
      type: 'current_month', start: '2026-08-01', end: '2026-08-07',
      key: 'current_month:2026-08-01:2026-08-07', label: 'Current month',
    },
    checkDefs: [{ type: 'unapproved_bills', label: 'Unapproved Bills', importance: 'medium', count: 1, potential_value_gbp: 10 }],
    reportFindings: { unapproved_bills: [{ finding_key: 'x', review_state: 'active', number: 'B1', amount: 10 }] },
    statementImports: [], scoreBreakdown: { profileStatus: 'provisional', profileVersion: 'v1' },
    generatedAt: '2026-08-07T12:00:00Z', practiceLogo: '', practiceName: 'MTA',
  });
  assert.match(html, /Bookkeeping health report/);
  assert.match(html, /current_month:2026-08-01:2026-08-07/);
  assert.match(html, /Dismissed findings/);
});
