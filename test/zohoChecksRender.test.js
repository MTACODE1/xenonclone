// What a Zoho Books UAE client's pages show for the new statuses: the UAE check names and wording, the reasons for
// "Unavailable", "Not applicable" and "Reconnect Zoho Books", and the UAE Tax Registration card in place of
// Companies House. (Xero pages are compared byte for byte with the previous views separately.) Made-up data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

const { currencyPrefix, formatMoney } = require('../src/services/money');
const { formatTurnoverGbp, groupSupplierTransactions } = require('../src/services/checkPresentation');
const { ALL_CHECK_DEFINITIONS, resolveCheckDisplayStatus } = require('../src/services/checkRules');
const { checkDescriptionsFor, checkLabelFor } = require('../src/data/checkDescriptionsUae');

const VIEWS = path.join(__dirname, '../src/views');
const globals = { currencyPrefix, formatMoney, basePath: '/akrio-verify', csrfToken: 'token', practiceName: 'P', cssVersion: 't',
  staffName: null, staffRole: null, isStaffManager: false, canAccessSettings: false };
const scope = { ledger: 'zoho', region: 'AE' };
const STATUS = {
  vat_scheme_threshold: ['rolling_12_months', 1], directors_loan_overdrawn: ['unavailable_zoho', null],
  dividend_status: ['not_applicable_uae', 0], bank_balance: ['needs_zoho_bank_access', null],
  bill_or_direct: ['needs_zoho_expense_access', null], unexpected_account_used: ['not_applicable_zoho', 0],
};
const checkDefs = ALL_CHECK_DEFINITIONS.map(def => {
  const [periodChecked, count] = STATUS[def.type] || ['since_lock_date', 0];
  const merged = { ...def, label: checkLabelFor(def.type, scope) || def.label, count, potential_value_gbp: 0, period_checked: periodChecked };
  return { ...merged, displayStatus: resolveCheckDisplayStatus(merged) };
});

function renderClient(extra = {}) {
  return ejs.renderFile(path.join(VIEWS, 'client.ejs'), {
    ...globals, ...require('../src/services/ledgers'), ukDate: require('../src/services/displayDate').ukDate, query: {},
    org: { id: 1, name: 'Made Up FZ LLC', freeagent_company_id: 'zoho-600000001', score: 80, total_issues: 1, total_potential_errors_gbp: 0,
      last_successful_sync_at: '2026-11-24T02:00:00Z' },
    issues: [], checkDefs, selectedPeriod: { type: 'since_lock_date', key: 'k', label: 'L', start: '2026-01-01', end: '2026-11-01' },
    periodQuery: '', periodMenu: [], periodView: null, isStale: false, txCounts: { turnover: null, total_transactions: 1 },
    bankReconciliation: [], excludedBankAccountIds: [], statementImports: [], filedAccounts: [], filedAccountsExtractions: [],
    companiesHouse: null, companiesHouseKeySet: true, expenseAccounts: [], accountConfigurations: [], scoreBreakdown: null,
    insight: {}, insightDate: null, insightKv: {}, insightMappings: [], insightWidgetVisibility: {},
    checkDescriptions: checkDescriptionsFor(scope), formatTurnoverGbp, clientCurrency: 'AED',
    uaeTaxCard: { profile: { isTaxRegistered: true, taxRegNo: '100000000000003', taxRegNoLabel: 'TRN', taxRegisteredDate: '2020-01-01', isFreeZone: false } },
    ...extra,
  });
}

test('Zoho UAE client page: UAE check names, reasons for each status, and the UAE Tax Registration card', async () => {
  const html = await renderClient();
  for (const text of ['VAT &amp; Corporate Tax Thresholds', 'Shareholder &amp; Related Party Balances', 'Motor Vehicle &amp; Entertainment VAT',
    'Zoho gives each account&#39;s current balance', 'a UK check: UAE dividends carry no withholding tax',
    'Update from Zoho Books (or reconnect Zoho Books to allow bank access)', 'Needs Zoho bank reading', 'href="#zoho-bank-screen"',
    'Reconnect Zoho Books to allow expense access', '/akrio-verify/auth/zoho/connect',
    'Zoho Books contacts have no default account to compare with', 'UAE Tax Registration', '100000000000003']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(!html.includes('id="companies-house"'), 'no Companies House card (or call) for a UAE company');
  assert.ok(!/HMRC/.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), 'no HMRC wording');
});

test('a Zoho client with no UAE card still gets the Companies House card, as before', async () => {
  const html = await renderClient({ uaeTaxCard: null });
  assert.ok(html.includes('id="companies-house"'));
  assert.ok(!html.includes('UAE Tax Registration'));
});

test('check page: "Unavailable" and "Reconnect Zoho Books" say why, instead of "null issues found"', async () => {
  const render = (checkType, periodChecked) => {
    const issue = { count: null, potential_value_gbp: 0, period_checked: periodChecked };
    return ejs.renderFile(path.join(VIEWS, 'checkDetail.ejs'), {
      ...globals, org: { name: 'Made Up FZ LLC', id: 1, freeagent_company_id: 'zoho-600000001' }, issue,
      def: { ...ALL_CHECK_DEFINITIONS.find(d => d.type === checkType), label: checkLabelFor(checkType, scope) || checkType },
      items: [], pagination: { page: 1, totalPages: 1, total: 0, items: [] }, summary: { active: 0, dismissed: 0, ignored: 0, ok: 0 },
      status: 'all', contact: '', checkType, checkDescriptions: checkDescriptionsFor(scope), groupSupplierTransactions, clientCurrency: 'AED',
      displayStatus: resolveCheckDisplayStatus(issue),
    });
  };
  const unavailable = await render('directors_loan_overdrawn', 'unavailable_zoho');
  assert.ok(unavailable.includes('Shareholder &amp; Related Party Balances'));
  assert.ok(unavailable.includes('Zoho Books&#39; API does not give the data this check needs'));
  assert.ok(!unavailable.includes('issues found'));
  const reconnect = await render('bank_balance', 'needs_zoho_bank_access');
  assert.ok(reconnect.includes('the Zoho Books connection does not allow bank access'));
});

test('Zoho client page: no Bank Statement Evidence, Bank Statement Reconciliation or Filed Accounts Evidence cards; a Xero page keeps them', async () => {
  const zohoHtml = await renderClient();
  for (const id of ['statement-evidence', 'bank-reconciliation', 'filed-accounts']) assert.ok(!zohoHtml.includes(`id="${id}"`), id);
  assert.ok(!zohoHtml.includes('Bank Statement Evidence') && !zohoHtml.includes('Filed Accounts Evidence'));
  assert.ok(!zohoHtml.includes('href="#bank-reconciliation"') && !zohoHtml.includes('href="#filed-accounts"'), 'no set-up link to a hidden card');
  const xeroHtml = await renderClient({ org: { id: 2, name: 'Made Up Ltd', xero_tenant_id: 'tenant-0000', score: 80, total_issues: 1, total_potential_errors_gbp: 0,
    last_successful_sync_at: '2026-11-24T02:00:00Z' }, uaeTaxCard: undefined, checkDescriptions: require('../src/data/checkDescriptions'), clientCurrency: 'GBP', extensionStoreUrl: 'https://example.invalid/store' });
  for (const id of ['statement-evidence', 'bank-reconciliation', 'filed-accounts']) assert.ok(xeroHtml.includes(`id="${id}"`), `Xero keeps ${id}`);
});

test('check page: a Zoho line-item check says how many documents have no lines read yet; nothing is shown without the note', async () => {
  const render = extra => ejs.renderFile(path.join(VIEWS, 'checkDetail.ejs'), {
    ...globals, org: { name: 'Made Up FZ LLC', id: 1, freeagent_company_id: 'zoho-600000001' },
    issue: { count: 0, potential_value_gbp: 0, period_checked: 'since_lock_date' }, def: ALL_CHECK_DEFINITIONS.find(d => d.type === 'purchase_tax_missing'),
    items: [], pagination: { page: 1, totalPages: 1, total: 0, items: [] }, summary: { active: 0, dismissed: 0, ignored: 0, ok: 0 },
    status: 'all', contact: '', checkType: 'purchase_tax_missing', checkDescriptions: checkDescriptionsFor(scope), groupSupplierTransactions,
    clientCurrency: 'AED', displayStatus: 'ok', ...extra,
  });
  const note = '8 Zoho Books documents in the period have not had their lines read yet, so they are not in this check.';
  const withNote = await render({ zohoUnreadNote: note });
  assert.ok(withNote.includes(`<p class="check-note">${note}</p>`));
  const without = await render({});
  assert.ok(!without.includes('have not had their lines read yet'));
  assert.equal(without, await render({ zohoUnreadNote: null }), 'no note: the page is exactly as before');
});

test('check page: a Zoho check waiting for its first read says "Needs sync", not "null issues found"', async () => {
  const issue = { count: null, potential_value_gbp: 0, period_checked: 'needs_sync' };
  const html = await ejs.renderFile(path.join(VIEWS, 'checkDetail.ejs'), {
    ...globals, org: { name: 'Made Up FZ LLC', id: 1, freeagent_company_id: 'zoho-600000001' }, issue,
    def: ALL_CHECK_DEFINITIONS.find(d => d.type === 'unreconciled_bank_items'), items: [], pagination: { page: 1, totalPages: 1, total: 0, items: [] },
    summary: { active: 0, dismissed: 0, ignored: 0, ok: 0 }, status: 'all', contact: '', checkType: 'unreconciled_bank_items',
    checkDescriptions: checkDescriptionsFor(scope), groupSupplierTransactions, clientCurrency: 'AED', displayStatus: resolveCheckDisplayStatus(issue),
  });
  assert.ok(html.includes('has not been read from Zoho Books yet'));
  assert.ok(!html.includes('issues found'));
});

// ---- Unreconciled Bank and the balance checks, round 2 of the live checks (made-up rows) ----
const { runZohoChecks, unreconciledTotals } = require('../src/services/zohoChecks');
const zohoMapping = require('../src/services/ledgers/zoho/mapping');

function renderCheck(checkType, items, issue, extra = {}) {
  const decorated = items.map((item, index) => ({ ...item, finding_key: `k${index}`, review_state: 'active', xero_links: [] }));
  return ejs.renderFile(path.join(VIEWS, 'checkDetail.ejs'), {
    ...globals, org: { name: 'Made Up FZ LLC', id: 1, freeagent_company_id: 'zoho-600000001' }, issue,
    def: ALL_CHECK_DEFINITIONS.find(d => d.type === checkType), items: decorated, previousItems: [],
    pagination: { page: 1, totalPages: 1, total: decorated.length, items: decorated }, previousPagination: { page: 1, totalPages: 1, total: 0, items: [] },
    summary: { active: decorated.length, dismissed: 0, ignored: 0, ok: 0, previous: 0 }, status: 'all', contact: '', checkType,
    checkDescriptions: checkDescriptionsFor(scope), groupSupplierTransactions, clientCurrency: 'AED', displayStatus: resolveCheckDisplayStatus(issue), ...extra,
  });
}
function zohoIssues(accounts, contacts = []) {
  const period = { type: 'since_lock_date', key: 'since_lock_date', start: '2026-06-30', end: '2026-11-10' };
  const money = { base: 'AED', converts: true, foreignCode: () => null, noRate: () => false, converted: a => a, inBase: a => a, currencyFields: () => ({}) };
  const { issues } = runZohoChecks({ org: { id: 1 }, period, region: 'AE', taxProfile: { isTaxRegistered: true }, contacts, money, now: new Date('2026-11-10T12:00:00Z'),
    accounting: { accounts, taxRates: [], manualJournals: [], bankTransactions: [], readStatus: { permissions: { banking: true, expenses: true }, sections: { balances: { read: true } } } } });
  return Object.fromEntries(issues.map(issue => [issue.check_type, issue]));
}

test('check page, Zoho Unreconciled Bank: bank account, payee, description and Money in / Money out; the headline is the net, the gross is in the note', async () => {
  const bank = zohoMapping.mapAccount({ account_id: 'a-bank', account_name: 'Made Up Bank Current', account_type: 'bank', is_active: true });
  const tx = raw => zohoMapping.mapAccountTransaction({ reconcile_status: 'unreconciled', ...raw }, bank);
  const unreconciled = [
    tx({ transaction_id: 't1', transaction_date: '2026-08-01', transaction_type: 'customer_payment', debit_amount: 1500, credit_amount: 0, payee: 'Made-up Customer' }),
    tx({ transaction_id: 't2', transaction_date: '2026-08-02', transaction_type: 'expense', debit_amount: 0, credit_amount: 210, offset_account_name: 'Tax Payable', vendor_id: 'v-1' }),
  ];
  const issues = zohoIssues([{ ...bank, reconciliation: { readAt: '2026-11-10T00:00:00Z', from: '2000-01-01', to: '2026-11-10', complete: true, rows: 2, reconciled: 0, unknown: 0, unreconciled } }],
    [{ contactID: 'v-1', name: 'Made-up Fuel Supplier' }]);
  const issue = { ...issues.unreconciled_bank_items, id: 1 };
  const items = JSON.parse(issue.detail_json);
  const html = await renderCheck('unreconciled_bank_items', items, issue, { zohoUnreconciled: unreconciledTotals(issue.detail_json) });
  for (const text of ['Made Up Bank Current', 'Made-up Customer', 'Made-up Fuel Supplier', 'Money in', 'Money out', 'Customer payment',
    'AED 1,290.00</strong><span>net unmatched value (money in minus money out)', 'money in AED 1,500.00 minus money out AED 210.00 = AED 1,290.00 over 2 transactions',
    'gross, money in plus money out: AED 1,710.00']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('Tax Payable'), 'the offset account is not shown');
  assert.ok(!html.includes('zoho-unreconciled:'), 'no internal id column');
  assert.ok(!html.includes('>potential value<'), 'the gross is not the headline');
  // Checked live quarter by quarter against Zoho's Reconciliation Status report (25 Nov 2026), so the About text says so.
  assert.ok(html.includes('lists as unreconciled for each account'), 'About text says the rule');
  assert.ok(!html.includes('matched to a line of an imported bank statement'), 'the disproved matched-rows rule is gone');
  // A net below zero is shown with its sign.
  const negative = await renderCheck('unreconciled_bank_items', items, issue, { zohoUnreconciled: { ...unreconciledTotals(issue.detail_json), net: -40.5 } });
  assert.ok(negative.includes('-AED 40.50</strong>'));
  // Without the totals (any other client), the page shows the stored value as before.
  const plain = await renderCheck('unreconciled_bank_items', items, issue);
  assert.ok(plain.includes('AED 1,710.00</strong><span>potential value'));
});

test('check page, Zoho Unreconciled Bank on several accounts: one net per account as Zoho reports them, the combined figure labelled, and rows in another currency explained', async () => {
  const totals = unreconciledTotals([
    { account: 'Made Up Bank Current', direction: 'Money in', amount: 1000 },
    { account: 'Made Up Bank Current', direction: 'Money out', amount: 200 },
    { account: 'Made Up Credit Card', direction: 'Money out', amount: 300 },
    { account: 'Made Up USD Bank', direction: 'Money out', amount: 50, currency: 'USD', potentialValue: 0 },
  ]);
  const issue = { check_type: 'unreconciled_bank_items', count: 4, potential_value_gbp: 1500, period_checked: 'since_lock_date', id: 1, detail_json: '[]' };
  const html = await renderCheck('unreconciled_bank_items', [], issue, { zohoUnreconciled: totals });
  for (const text of [
    'AED 800.00</strong><span>net unmatched value, Made Up Bank Current',
    '-AED 300.00</strong><span>net unmatched value, Made Up Credit Card',
    'All accounts combined: money in AED 1,000.00 minus money out AED 500.00 = AED 500.00 over 3 transactions',
    '1 transaction in another currency is listed but not added',
  ]) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('<span>net unmatched value (money in minus money out)'), 'no single combined headline when there are several accounts');
});

test('check page, Zoho Suspense and Shareholder balances: the account name and balance, never the Zoho account id', async () => {
  const withBalance = (raw, amount) => ({ ...zohoMapping.mapAccount({ is_active: true, account_code: '', ...raw }), ledgerBalance: { amount, side: null, source: 'chart_list', readAt: '2026-11-09T10:00:00.000Z' } });
  const issues = zohoIssues([
    withBalance({ account_id: '8000000000000001', account_name: 'Suspense', account_type: 'other_current_liability' }, -320.25),
    withBalance({ account_id: '8000000000000002', account_name: 'Shareholder Loan Account - Made Up', account_type: 'other_current_asset' }, 900),
  ]);
  for (const [checkType, name, amount] of [['suspense_open_balance', 'Suspense', 'AED 320.25'], ['directors_loan_overdrawn', 'Shareholder Loan Account - Made Up', 'AED 900.00']]) {
    const issue = { ...issues[checkType], id: 1 };
    const html = await renderCheck(checkType, JSON.parse(issue.detail_json), issue);
    assert.ok(html.includes(name), `${checkType}: ${name}`);
    assert.ok(html.includes(amount), `${checkType}: ${amount}`);
    assert.ok(!/8000000000000\d{3}/.test(html), `${checkType}: no Zoho account id on the page`);
  }
});

test('client page, Zoho Unreconciled Bank card: the net value, signed; other clients keep the stored value', async () => {
  const defs = checkDefs.map(def => (def.type === 'unreconciled_bank_items'
    ? { ...def, count: 3, potential_value_gbp: 900, period_checked: 'since_lock_date', displayStatus: 'issues', zohoUnreconciled: { net: -300.4, gross: 900 } } : def));
  const html = await renderClient({ checkDefs: defs });
  assert.ok(html.includes('-AED 300 net'));
  assert.ok(html.includes('all bank and card accounts combined'), 'the card says the net is every account added together');
  const plain = await renderClient({ checkDefs: defs.map(def => (def.type === 'unreconciled_bank_items' ? { ...def, zohoUnreconciled: undefined } : def)) });
  assert.ok(!plain.includes(' net</span>'));
  assert.ok(plain.includes('AED 900'));
});
