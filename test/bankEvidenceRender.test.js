// Renders the real check-detail template with made-up data: the Bank Balance cards must show the figures the
// check compared (bankEvidence.js), and Unprocessed Bank must show per-account rows from Xero's Bank accounts page.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { currencyPrefix } = require('../src/services/money');
const { buildBankEvidence } = require('../src/services/bankEvidence');
const { groupSupplierTransactions } = require('../src/services/checkPresentation');

const NOW = new Date('2026-11-20T12:00:00Z');
const locals = {
  basePath: '/akrio-verify', orgIdentifier: 'synthetic-org', csrfToken: 'token',
  org: { name: 'Synthetic Ltd', id: 1, xero_tenant_id: 'synthetic-org' },
  summary: { active: 1, dismissed: 0, ignored: 0, ok: 0 }, status: 'active', contact: '', checkDescriptions: {},
  groupSupplierTransactions,
  practiceName: 'Synthetic Practice', cssVersion: 'test', staffName: null, staffRole: null, isStaffManager: false, canAccessSettings: false,
  currencyPrefix,
};
const screen = (name, extra = {}) => ({
  accountName: name, accountNumber: null, itemsToReconcile: 0, reconciled: false, balancesDiffer: false,
  balanceInXero: 100, statementBalance: 100, statementDateLabel: 'Nov 20', feedProblem: false, stoppedImporting: false, noFeed: false, ...extra,
});
const reading = accounts => ({ batchId: 3, readAt: new Date('2026-11-20T09:15:00Z'), readByName: 'Test <Person>', accounts });

function renderBankBalance(evidence) {
  const items = evidence.bankBalance.findings.map((item, index) => ({ ...item, finding_key: 'fk-' + index, review_state: 'active', standaloneNote: index === 0 ? 'Agreed with the client <b>' : null }));
  return ejs.renderFile(path.join(__dirname, '../src/views/checkDetail.ejs'), {
    ...locals, checkType: 'bank_balance',
    def: { type: 'bank_balance', label: 'Bank Balance Check', importance: 'critical' },
    issue: { count: items.length, potential_value_gbp: evidence.bankBalance.value, period_checked: 'statement_comparison_as_of_2026-11-30' },
    items, pagination: { page: 1, totalPages: 1, total: items.length, items },
    bankAccounts: evidence.accounts, bankReading: evidence.reading,
  });
}

test('Bank Balance cards show the bank feed balance, the Xero balance and their difference', async () => {
  const evidence = buildBankEvidence({
    reconciliation: [
      { bank_account_id: 'A', bank_account_name: 'Current Account', xero_calculated_balance: 1, xero_balance_as_of: '2026-11-30', statement_balance: null },
      { bank_account_id: 'B', bank_account_name: 'Savings', xero_calculated_balance: 50, xero_balance_as_of: '2026-11-30', statement_balance: null },
    ],
    reading: reading([
      screen('Current Account', { statementBalance: 718.06, balanceInXero: -326.19, statementDateLabel: 'Nov 20' }),
      screen('Savings', { statementBalance: 50, balanceInXero: 50 }),
      screen('PayPal <GBP>', { statementBalance: 10, balanceInXero: 0, feedProblem: true }),
    ]),
    now: NOW,
  });
  const html = await renderBankBalance(evidence);
  const card = name => {
    const start = html.indexOf(`<h5 class="bb-account-name">${name}</h5>`);
    assert.ok(start > 0, `card for ${name}`);
    return html.slice(html.lastIndexOf('<div class="bb-account-card', start), html.indexOf('<div class="bb-account-card', start + 10) > 0 ? html.indexOf('<div class="bb-account-card', start + 10) : undefined);
  };
  const current = card('Current Account');
  assert.match(current, /Per Xero Statement[\s\S]*£718\.06[\s\S]*\(Nov 20\)/);
  assert.match(current, /Per Xero TB[\s\S]*-£326\.19/);
  assert.match(current, /Difference[\s\S]*£1,044\.25/);
  assert.match(current, /Compared using: Xero Bank accounts screen/);
  assert.match(current, /name="finding_key" value="fk-0"/, 'Mark as OK posts this account\'s finding');
  assert.match(current, /check\/bank_balance\/note/, 'a note can be added against the account');
  assert.match(current, /Agreed with the client &lt;b&gt;/, 'an existing note is shown, escaped');
  assert.match(current, /Click to add balance/);
  // A matching account is hidden until "Show all" is ticked, like Xenon.
  assert.match(card('Savings'), /data-has-disc="0"[^>]*style="display:none;"/);
  // An account Verify doesn't know: shown, escaped, no exclude or typed-balance forms.
  const paypal = card('PayPal &lt;GBP&gt;');
  assert.match(paypal, /problem with this bank feed/);
  assert.doesNotMatch(paypal, /bank-account-exclusion|bank-reconciliation/);
  assert.match(html, /read 20 Nov 2026, 09:15 by Test &lt;Person&gt;/);
  assert.doesNotMatch(html, /2026 Nov 20|Nov 20 2026/, 'no year is invented for Xero\'s statement date');
});

test('Bank Balance says when the reading is too old to use', async () => {
  const evidence = buildBankEvidence({ reading: { ...reading([screen('Current Account')]), readAt: new Date('2026-10-01T00:00:00Z') }, now: NOW });
  const html = await renderBankBalance(evidence);
  assert.match(html, /more than 7 days old/);
  assert.match(html, /href="\/akrio-verify\/client\/synthetic-org#bank-screen">Update from Xero/);
});

test('Unprocessed Bank lists one row per account with the number of items and the feed state', async () => {
  const evidence = buildBankEvidence({
    reading: reading([screen('Card', { itemsToReconcile: 67, stoppedImporting: true }), screen('Stripe', { itemsToReconcile: 262 })]), now: NOW,
  });
  const items = evidence.unprocessed.findings.map((item, index) => ({ ...item, finding_key: 'u' + index, review_state: 'active', xero_links: [] }));
  const html = await ejs.renderFile(path.join(__dirname, '../src/views/checkDetail.ejs'), {
    ...locals, checkType: 'unprocessed_bank', fmtDisplayDate: value => String(value),
    def: { type: 'unprocessed_bank', label: 'Unprocessed Bank', importance: 'critical' },
    issue: { count: 2, potential_value_gbp: 0, period_checked: 'bank_screen_2026-11-20' },
    items, pagination: { page: 1, totalPages: 1, total: 2, items }, summary: { active: 2, dismissed: 0, ignored: 0, ok: 0 },
  });
  assert.match(html, />\s*67\s*</);
  assert.match(html, />\s*262\s*</);
  assert.match(html, /Stopped importing/);
  assert.match(html, /items To Reconcile/i);
  assert.doesNotMatch(html, /bankAccountId|batchId|bank Account Id/i, 'internal ids are not columns');
});
