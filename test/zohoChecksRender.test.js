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
    'Zoho Books&#39; API gives no account balances', 'a UK check: UAE dividends carry no withholding tax',
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
