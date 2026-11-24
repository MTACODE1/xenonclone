// Amounts are shown in the client's own currency (24 Nov 2026). Verify started as UK/Xero only, so every page
// wrote "£"; Zoho Books clients in the UAE keep their books in AED and their figures were shown as pounds.
// Amounts are never converted: only the label changes. A client with no stored currency (every Xero and FreeAgent
// client) must render exactly as before. Made-up data throughout.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

// ---- a stand-in MySQL pool, so the currency store can be exercised without a database ----
const queries = [];
const stored = new Map();
const fakePool = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/^CREATE TABLE IF NOT EXISTS akrio_org_currency/.test(sql)) return [{}, []];
    if (/^INSERT INTO akrio_org_currency/.test(sql)) { stored.set(params[0], params[1]); return [{ affectedRows: 1 }, []]; }
    if (/WHERE org_id = \?/.test(sql)) {
      return [stored.has(params[0]) ? [{ currency_code: stored.get(params[0]) }] : [], []];
    }
    if (/WHERE org_id IN/.test(sql)) {
      return [params.filter(id => stored.has(id)).map(id => ({ org_id: id, currency_code: stored.get(id) })), []];
    }
    throw new Error(`unexpected query: ${sql}`);
  },
};
const poolPath = require.resolve('../src/db/mysqlPool');
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => fakePool } };

const { saveOrgCurrency, getOrgCurrency, getOrgCurrencies } = require('../src/db/orgCurrency');
const { currencyPrefix, formatMoney } = require('../src/services/money');
const { formatTurnoverGbp, groupSupplierTransactions } = require('../src/services/checkPresentation');
const { CHECK_DEFINITIONS } = require('../src/services/checkRules');

const VIEWS = path.join(__dirname, '../src/views');

// ---- (a) the money helper ----

// The formatter exactly as it was before currencies (checkPresentation.js up to 24 Nov 2026).
function oldTurnover(value) {
  const number = Number(value);
  const amount = Number.isFinite(number) ? number : 0;
  const text = Math.abs(amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${amount < 0 && Number(text.replace(/,/g, '')) !== 0 ? '-' : ''}£${text}`;
}
const VALUES = [0, -0, 0.004, -0.004, 0.005, 1, -1, 22, 1188, 1234.05, 1234.49, 181990.36999999988, -50, -1234.567,
  999.995, 1000000, -1000000, 163290.4, null, undefined, 'abc', '12.5', NaN, Infinity];

test('GBP (and no currency, or a bad one) is written exactly as before', () => {
  for (const value of VALUES) {
    for (const code of ['GBP', undefined, null, '', 'gbp', 'XX', '£', 'GBPX']) {
      assert.equal(formatMoney(value, code), oldTurnover(value), `${String(value)} / ${String(code)}`);
      assert.equal(formatTurnoverGbp(value, code), oldTurnover(value));
    }
    assert.equal(formatTurnoverGbp(value), oldTurnover(value), 'no currency given: unchanged');
  }
  // Whole units, as the pages round them: the same as the old '£' + Math.round(value).toLocaleString('en-GB').
  for (const value of [0, 1, 22, 1188, 163290.4, 1234567.89]) {
    assert.equal(formatMoney(value, 'GBP', { decimals: 0 }), '£' + Math.round(value).toLocaleString('en-GB'));
  }
  assert.equal(currencyPrefix('GBP'), '£');
  assert.equal(currencyPrefix(undefined), '£');
  assert.equal(currencyPrefix('not a code'), '£');
});

test('another currency is shown by its code, with the same grouping and sign rules', () => {
  assert.equal(currencyPrefix('AED'), 'AED ');
  assert.equal(currencyPrefix('aed'), 'AED ');
  assert.equal(formatMoney(163290.4, 'AED'), 'AED 163,290.40');
  assert.equal(formatMoney(163290.4, 'AED', { decimals: 0 }), 'AED 163,290');
  assert.equal(formatMoney(-50, 'AED'), '-AED 50.00');
  assert.equal(formatMoney(-0.001, 'AED'), 'AED 0.00', 'a tiny negative does not read as -AED 0.00');
  assert.equal(formatTurnoverGbp(1234.05, 'USD'), 'USD 1,234.05');
  assert.ok(!formatMoney(1, 'AED').includes('£'));
});

// ---- the currency store ----

test('the store keeps a valid code per client, ignores anything else, and defaults to GBP', async () => {
  assert.equal(await getOrgCurrency(7), 'GBP', 'no row: GBP');
  assert.equal(await saveOrgCurrency(7, 'AED'), true);
  assert.equal(await getOrgCurrency(7), 'AED');
  for (const bad of [null, '', 'AE', 'AEDX', '12A', undefined]) assert.equal(await saveOrgCurrency(7, bad), false, String(bad));
  assert.equal(await saveOrgCurrency(0, 'AED'), false, 'no client id: nothing written');
  assert.equal(await getOrgCurrency(7), 'AED', 'a bad value never overwrites a good one');
  assert.equal(await saveOrgCurrency(8, ' usd '), true, 'trimmed and upper-cased');
  assert.equal(await getOrgCurrency(8), 'USD');

  const before = queries.filter(q => /WHERE org_id IN/.test(q.sql)).length;
  const map = await getOrgCurrencies([7, 8, 9, 7, null]);
  assert.equal(queries.filter(q => /WHERE org_id IN/.test(q.sql)).length, before + 1, 'one query for the whole list');
  assert.deepEqual([...map], [[7, 'AED'], [8, 'USD'], [9, 'GBP']]);
  assert.deepEqual([...(await getOrgCurrencies([]))], []);
  assert.equal(queries.filter(q => /^CREATE TABLE/.test(q.sql)).length, 1, 'the table is created once, on first use');
});

test('the Zoho/QuickBooks sync saves the base currency; the Xero sync is not changed', () => {
  const ledgerSync = fs.readFileSync(path.join(__dirname, '../src/services/ledgerSync.js'), 'utf8');
  assert.match(ledgerSync, /saveOrgCurrency\(org\.id, info\.baseCurrency\)/);
  const xeroSync = fs.readFileSync(path.join(__dirname, '../src/services/xeroSync.js'), 'utf8');
  assert.ok(!xeroSync.includes('orgCurrency'), 'Xero clients stay GBP by default');
  assert.match(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), /currencyPrefix, formatMoney/);
});

// ---- (b) and (c) the pages ----

const globals = { currencyPrefix, formatMoney, basePath: '/akrio-verify', csrfToken: 'token', practiceName: 'P', cssVersion: 't',
  staffName: null, staffRole: null, isStaffManager: false, canAccessSettings: false };

function renderCheckDetail(extra = {}) {
  const items = [
    { finding_key: 'k1', number: 'INV-1', contact: 'Supplier One', date: '2026-10-02', amount: 1188, review_state: 'active', xero_links: [], standaloneNote: null,
      documents: [{ reference: 'B-0', amount: null, status: 'PAID', date: '2026-08-01' }] },
    { finding_key: 'k2', number: 'INV-2', contact: 'Supplier Two', date: '2026-10-03', amount: -23.2, review_state: 'active', xero_links: [], standaloneNote: null,
      documents: [{ reference: 'B-1', amount: 1500.5, status: 'AUTHORISED', date: '2026-09-01' }] },
  ];
  return ejs.renderFile(path.join(VIEWS, 'checkDetail.ejs'), {
    ...globals, org: { name: 'Made Up Ltd', id: 1, freeagent_company_id: 'zoho-1' },
    issue: { count: 2, potential_value_gbp: 163290.4, period_checked: 'since_lock_date', synced_at: '2026-11-24' },
    def: { type: 'duplicate_bills', label: 'Duplicate Bills', importance: 'high' },
    items, pagination: { page: 1, totalPages: 1, total: 2, items }, summary: { active: 2, dismissed: 0, ignored: 0, ok: 0 },
    status: 'active', contact: '', checkType: 'duplicate_bills', checkDescriptions: {}, groupSupplierTransactions, ...extra,
  });
}

test('check detail: with no currency the money is written in pounds exactly as before', async () => {
  const html = await renderCheckDetail();
  for (const shown of ['£163,290.40', '£1,188.00', '-£23.20', 'B-1 · £1,500.50']) assert.ok(html.includes(shown), shown);
  assert.ok(!html.includes('AED'));
  assert.equal(html, await renderCheckDetail({ clientCurrency: 'GBP' }), 'GBP stored and nothing stored render the same page');
});

test('check detail: an AED client shows AED and no £', async () => {
  const html = await renderCheckDetail({ clientCurrency: 'AED' });
  for (const shown of ['AED 163,290.40', 'AED 1,188.00', '-AED 23.20', 'B-1 · AED 1,500.50']) assert.ok(html.includes(shown), shown);
  assert.ok(!html.includes('£'), 'no pound sign anywhere on the page');
});

// A row for a document in another currency (a USD invoice on an AED client) carries "currency"; its figures are in
// that currency and not converted, so they must not be labelled as the client's currency.
test('check detail: a row in another currency shows its own code, marked as not converted', async () => {
  const items = [
    { finding_key: 'k1', number: 'INV-1', contact: 'Customer One', date: '2026-09-01', amountDue: 500, currency: 'USD', review_state: 'active', xero_links: [] },
    { finding_key: 'k2', number: 'INV-2', contact: 'Customer Two', date: '2026-09-02', amountDue: 1200, review_state: 'active', xero_links: [] },
  ];
  const html = await renderCheckDetail({ clientCurrency: 'AED', items, pagination: { page: 1, totalPages: 1, total: 2, items } });
  assert.ok(html.includes('USD 500.00'), 'the USD figure is labelled USD');
  assert.ok(!html.includes('AED 500.00'), 'never labelled as AED');
  assert.ok(html.includes('AED 1,200.00'), 'the AED row is unchanged');
  assert.ok(html.includes('not converted'));
  // With every row in the client's currency, nothing extra is shown.
  const plain = await renderCheckDetail({ clientCurrency: 'AED' });
  assert.ok(!plain.includes('not converted'));
  // On a GBP (Xero) client a foreign row is no longer shown with a pound sign either.
  const gbp = await renderCheckDetail({ items, pagination: { page: 1, totalPages: 1, total: 2, items } });
  assert.ok(gbp.includes('USD 500.00') && gbp.includes('£1,200.00') && !gbp.includes('£500.00'));
});

// The client page with every check listed, a score breakdown row, a statement import and turnover.
function renderClient(extra = {}) {
  const checkDefs = CHECK_DEFINITIONS.map((def, i) => ({ ...def, count: i % 2, potential_value_gbp: i % 2 ? 1234.5 : 0, displayStatus: i % 2 ? 'issues' : 'clean' }));
  return ejs.renderFile(path.join(VIEWS, 'client.ejs'), {
    ...globals, ...require('../src/services/ledgers'), ukDate: require('../src/services/displayDate').ukDate, query: {},
    org: { id: 1, name: 'Made Up Ltd', freeagent_company_id: 'zoho-1', score: 70, total_issues: 3, total_potential_errors_gbp: 163290.4,
      last_successful_sync_at: '2026-11-24T02:00:00Z' },
    issues: [], checkDefs, selectedPeriod: { type: 'since_lock_date', key: 'k', label: 'L', start: '2026-01-01', end: '2026-11-01' },
    periodQuery: '', periodMenu: [], periodView: null, isStale: false, txCounts: { turnover: 120000.5, total_transactions: 10 },
    bankReconciliation: [], excludedBankAccountIds: [],
    statementImports: [{ id: 1, bank_account_name: 'Current', original_filename: 'statement.csv', file_sha256: 'abcdef0123456789',
      imported_at: '2026-11-01', statement_start_date: '2026-10-01', statement_end_date: '2026-10-31', opening_balance: 10, closing_balance: 20 }],
    filedAccounts: [], filedAccountsExtractions: [], companiesHouse: null, companiesHouseKeySet: false, expenseAccounts: [], accountConfigurations: [],
    scoreBreakdown: { profileStatus: 'p', profileVersion: 'v', totalDeduction: 3,
      observations: [{ checkType: 'x', importance: 'high', count: 2, source: 'active_findings', exposure: 500.4, ageDays: 10, deduction: 3 }] },
    insight: {}, insightDate: null, insightKv: {}, insightMappings: [], insightWidgetVisibility: {},
    checkDescriptions: require('../src/data/checkDescriptions'), formatTurnoverGbp, ...extra,
  });
}
// What a person reads: the page without its <script> blocks (the Insight charts' formatters are Xero-only, as is
// their data) and without the Low Cost Fixed Assets rule text, which quotes the practice's £2,000 capitalisation
// policy rather than an amount from the client's books.
const visibleText = html => html.replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/net value is less than or equal to £2,000\./g, '');

test('client page: with no currency the figures are in pounds as before', async () => {
  const html = await renderClient();
  for (const shown of ['£163,290', '£1,235', '£500', '£120,000.50', '£10,000/mth', '£10.00', 'Closing: £20.00', 'Opening Balance threshold (£)', 'placeholder']) {
    assert.ok(html.includes(shown), shown);
  }
  assert.ok(!visibleText(html).includes('AED'));
  assert.equal(html, await renderClient({ clientCurrency: 'GBP' }), 'GBP stored and nothing stored render the same page');
});

test('client page: an AED client shows AED and no £', async () => {
  const html = await renderClient({ clientCurrency: 'AED' });
  for (const shown of ['AED 163,290', 'AED 1,235', 'AED 500', 'AED 120,000.50', 'AED 10,000/mth', 'Closing: AED 20.00', 'Opening Balance threshold (AED)']) {
    assert.ok(html.includes(shown), shown);
  }
  assert.ok(!visibleText(html).includes('£'), 'no pound sign in the text a person reads');
});

// Net assets typed in by the accountant are in the client's own currency; a Companies House filing is in pounds.
test('client page: filed accounts show a typed-in figure in the client currency, a Companies House one in pounds', async () => {
  const filedAccounts = [
    { filing_date: '2025-12-31', net_assets: 50000, xero_net_assets: null, source: 'manual' },
    { filing_date: '2024-12-31', net_assets: 42000, xero_net_assets: 41000, source: 'companies_house' },
  ];
  const aed = await renderClient({ clientCurrency: 'AED', filedAccounts });
  assert.ok(aed.includes('Filed net assets AED 50,000.00'), 'typed-in figure in AED');
  assert.ok(aed.includes('Filed net assets £42,000.00'), 'Companies House figure stays in pounds');
  const gbp = await renderClient({ filedAccounts });
  assert.ok(gbp.includes('Filed net assets £50,000.00') && gbp.includes('Filed net assets £42,000.00') && gbp.includes('Xero: £41,000.00'));
  assert.equal(gbp, await renderClient({ clientCurrency: 'GBP', filedAccounts }));
});

// The Transactions page's CSV puts every client's turnover in one column; it must say which currency each is in.
test('transactions CSV export: a Currency column next to Turnover', () => {
  const source = fs.readFileSync(path.join(VIEWS, 'transactions.ejs'), 'utf8');
  const start = source.indexOf('function exportCSV()');
  const snippet = source.slice(start, source.indexOf('const csv =', start));
  const rendered = ejs.render(snippet, { rows: [
    { name: 'One Ltd', client_ref: 'A1', turnover: 1500.25, currency_code: 'GBP' },
    { name: 'Two FZ LLC', client_ref: 'A2', turnover: 163290.4, currency_code: 'AED' },
    { name: 'Three Ltd', client_ref: 'A3', turnover: 10 },
  ] });
  // Run the generated code and read back the rows it builds.
  const rows = new Function(rendered.replace('function exportCSV() {', '') + 'return rows;')();
  const header = rows[0];
  assert.equal(header[header.indexOf('Turnover') + 1], 'Currency');
  const col = header.indexOf('Currency');
  assert.deepEqual(rows.slice(1).map(row => row[col]), ['GBP', 'AED', 'GBP']);
  assert.equal(rows[2][header.indexOf('Turnover')], '163290.4');
  assert.equal(rows.every(row => row.length === header.length), true, 'every row lines up with the header');
});

test('report (and so its PDF): the exposure and per-check values use the client currency', () => {
  const source = fs.readFileSync(path.join(VIEWS, 'report.ejs'), 'utf8');
  const exposureLine = source.split('\n').find(line => line.includes('Potential exposure'));
  const valueLine = source.split('\n').find(line => line.includes('check.potential_value_gbp ?'));
  const render = (line, locals) => ejs.render(line.trim(), { ...globals, org: { total_potential_errors_gbp: 163290.4 }, check: { potential_value_gbp: 1234.5 }, ...locals });
  assert.match(render(exposureLine, {}), />£163,290</);
  assert.match(render(valueLine, {}), /<td>£1,234.50<\/td>/);
  assert.match(render(exposureLine, { clientCurrency: 'AED' }), />AED 163,290</);
  assert.match(render(valueLine, { clientCurrency: 'AED' }), /<td>AED 1,234.50<\/td>/);
  assert.ok(!source.includes('£'), 'no pound sign is written into the report template');
});

test('all-clients panorama: each row in its own currency, and totals are never added across currencies', async () => {
  const org = (id, name, value, currency_code) => ({ id, name, xero_tenant_id: currency_code ? null : `t-${id}`, freeagent_company_id: currency_code ? `zoho-${id}` : null,
    score: 80, total_issues: 1, total_potential_errors_gbp: value, connection_status: 'connected', issueBreakdown: [], currency_code: currency_code || 'GBP' });
  const render = (orgs, totalErrors, otherErrorTotals) => ejs.renderFile(path.join(VIEWS, 'panorama.ejs'), {
    ...globals, orgs, totalIssues: orgs.length, totalErrors, otherErrorTotals, totalUnreconciled: 0, avgScore: 80, allTags: [], query: {},
  });
  const gbpOnly = await render([org(1, 'One Ltd', 1500.25), org(2, 'Two Ltd', 10)], 1510.25, []);
  for (const shown of ['£1,510', '£1,500.25', '£10.00', 'Potential £']) assert.ok(gbpOnly.includes(shown), shown);
  assert.ok(!gbpOnly.includes('AED'));

  const mixed = await render([org(1, 'One Ltd', 1500.25), org(2, 'Two FZ LLC', 163290.4, 'AED')], 1500.25, [{ code: 'AED', amount: 163290.4 }]);
  for (const shown of ['£1,500', '£1,500.25', 'AED 163,290.40', 'AED 163,290<']) assert.ok(mixed.includes(shown), shown);
  assert.ok(!mixed.includes('£164,790') && !mixed.includes('£163,290'), 'AED is never added into, or shown as, pounds');
  assert.ok(!mixed.includes('Potential £'), 'the shared column heading no longer claims pounds');
});

// ---- (d) the shared check engine ----
// The checks run for Zoho, QuickBooks and FreeAgent (ledgerChecks.js, with the rules in checkRules.js) save numbers
// only; every currency label is added when a page is drawn. So nothing saved at sync time needs a currency, and a
// pound sign must not creep into the text those checks build (it would be wrong for an AED client).
test('the shared check engine builds no text with a pound sign in it (comments aside)', () => {
  for (const file of ['../src/services/checkRules.js', '../src/services/ledgerChecks.js']) {
    const code = fs.readFileSync(path.join(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(line => line.replace(/(^|\s)\/\/.*$/, '')).join('\n');
    assert.ok(!code.includes('£'), `${file} writes a £ into a message`);
  }
});
