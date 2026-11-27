// Zoho Books clients: the bank card compares what the extension read from Zoho Books' Banking page with what Zoho's
// API gave at the last sync. Every name, id and figure here is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const {
  buildZohoBankComparison, matchAccounts, apiBankAccounts, compareAmount, compareCount, normaliseName, numberTail,
} = require('../src/services/zohoBankComparison');
const { createZohoBankScreenRouter } = require('../src/routes/zohoBankScreen');

const SYNC_AT = '2026-11-24T02:00:00.000Z';
const screenAccount = extra => ({ accountName: 'Test Bank Current', accountNumber: 'xxxx0001', uncategorised: 2, currency: 'AED',
  amountInBank: 1500, amountInBooks: 1400.25, ...extra });
const apiAccount = (extra = {}, bank = {}) => ({ accountID: '900001', name: 'Test Bank Current', type: 'BANK', status: 'ACTIVE', currencyCode: 'AED',
  ...extra,
  bank: { accountType: 'bank', currencyCode: 'AED', bookBalance: 1400.25, bookBalanceBase: 1400.25, bankBalance: 1500, uncategorizedCount: 2,
    feedsActive: true, accountNumber: 'xxxx0001', isActive: true, ...bank },
});
const reading = (accounts, readAt = '2026-11-24T09:00:00.000Z') => ({ batchId: 1, readAt: new Date(readAt), readByName: 'T', accounts });
const status = (banking = true, readAt = SYNC_AT) => ({ organisationID: 'zoho-60012345678', ledger: 'zoho', readAt, permissions: { banking, expenses: true } });

// ---- matching ----
test('names are normalised: trimmed, spaces collapsed, case ignored; masked numbers compare on the last four digits', () => {
  assert.equal(normaliseName('  Test   BANK  current '), 'test bank current');
  assert.equal(numberTail('xxxx0001'), '0001');
  assert.equal(numberTail('****-1234-0001'), '0001');
  assert.equal(numberTail(null), null);
  assert.equal(numberTail('none'), null);
});

test('matching by Zoho account id wins over the name', () => {
  const api = apiBankAccounts([apiAccount({ accountID: '900001', name: 'Renamed In Api' }), apiAccount({ accountID: '900002' })]);
  const { pairs, onlyScreen, onlyApi } = matchAccounts([screenAccount({ accountId: '900001' })], api);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].api.accountId, '900001');
  assert.deepEqual(onlyScreen, []);
  assert.deepEqual(onlyApi.map(a => a.accountId), ['900002']);
});

test('matching by normalised name, with the masked number deciding between same-named accounts', () => {
  const api = apiBankAccounts([
    apiAccount({ accountID: 'a1' }, { accountNumber: 'xxxx0009' }),
    apiAccount({ accountID: 'a2' }, { accountNumber: '****0001' }),
    apiAccount({ accountID: 'a3', name: 'Petty  Cash' }, { accountNumber: null }),
  ]);
  const screen = [screenAccount({ accountName: ' test bank CURRENT ' }), screenAccount({ accountName: 'petty cash', accountNumber: null })];
  const { pairs, onlyScreen, onlyApi } = matchAccounts(screen, api);
  assert.deepEqual(pairs.map(p => p.api.accountId), ['a2', 'a3']);
  assert.deepEqual(onlyScreen, []);
  assert.deepEqual(onlyApi.map(a => a.accountId), ['a1']);
  // Same name, numbers that disagree: no pair.
  const none = matchAccounts([screenAccount({ accountNumber: 'xxxx0005' })], apiBankAccounts([apiAccount()]));
  assert.equal(none.pairs.length, 0);
  assert.equal(none.onlyScreen.length, 1);
  assert.equal(none.onlyApi.length, 1);
});

// ---- cells ----
test('amounts agree to the cent (|difference| < 0.005); otherwise the difference is screen minus API', () => {
  assert.deepEqual(compareAmount(100, 100.004), { status: 'equal', screen: 100, api: 100.004, difference: 0 });
  assert.deepEqual(compareAmount(100, 100.01), { status: 'differ', screen: 100, api: 100.01, difference: -0.01 });
  assert.deepEqual(compareAmount(-12345.67, -12000), { status: 'differ', screen: -12345.67, api: -12000, difference: -345.67 });
  assert.equal(compareAmount(100, null).status, 'missing');
  assert.deepEqual(compareCount(3, 3), { status: 'equal', screen: 3, api: 3, difference: 0 });
  assert.deepEqual(compareCount(5, 3), { status: 'differ', screen: 5, api: 3, difference: 2 });
});

test('a "$" prefix on screen is compared with the API figure in the account currency; a different code is flagged', () => {
  const dollars = buildZohoBankComparison({
    reading: reading([screenAccount({ currency: '$', amountInBooks: -55254.31, amountInBank: 0, uncategorised: 0 })]),
    accounts: [apiAccount({ currencyCode: 'USD' }, { currencyCode: 'USD', bookBalance: -55254.31, bookBalanceBase: -202860.5, bankBalance: 0, uncategorizedCount: 0, feedsActive: false })],
    readStatus: status(),
  });
  const row = dollars.rows[0];
  assert.equal(row.books.status, 'equal');
  assert.equal(row.currencyDiffers, false);
  assert.equal(row.apiBookBalanceBase, -202860.5);
  const coded = buildZohoBankComparison({ reading: reading([screenAccount({ currency: 'EUR' })]), accounts: [apiAccount()], readStatus: status() });
  assert.equal(coded.rows[0].currencyDiffers, true);
});

test('uncategorised counts equal and different', () => {
  const same = buildZohoBankComparison({ reading: reading([screenAccount()]), accounts: [apiAccount()], readStatus: status() });
  assert.equal(same.rows[0].uncategorised.status, 'equal');
  assert.deepEqual(same.overall, { state: 'agree', total: 1, differ: 0, text: 'All 1 account agree ✓' });
  const other = buildZohoBankComparison({ reading: reading([screenAccount({ uncategorised: 7 })]), accounts: [apiAccount()], readStatus: status() });
  assert.equal(other.rows[0].uncategorised.status, 'differ');
  assert.equal(other.rows[0].uncategorised.difference, 5);
  assert.equal(other.rows[0].agrees, false);
  assert.equal(other.overall.text, '1 of 1 account differ');
});

test('Amount in Bank 0.00 with no feed on both sides is "no bank feed" and agrees; a feed showing 0 against a balance differs', () => {
  const noFeed = buildZohoBankComparison({
    reading: reading([screenAccount({ amountInBank: 0 })]),
    accounts: [apiAccount({}, { bankBalance: 0, feedsActive: false })], readStatus: status(),
  });
  assert.equal(noFeed.rows[0].bank.status, 'no_feed');
  assert.equal(noFeed.rows[0].agrees, true);
  const feedNull = buildZohoBankComparison({ reading: reading([screenAccount({ amountInBank: 0 })]), accounts: [apiAccount({}, { bankBalance: 0, feedsActive: null })], readStatus: status() });
  assert.equal(feedNull.rows[0].bank.status, 'no_feed');
  const oneSide = buildZohoBankComparison({ reading: reading([screenAccount({ amountInBank: 0 })]), accounts: [apiAccount({}, { bankBalance: 1500 })], readStatus: status() });
  assert.equal(oneSide.rows[0].bank.status, 'differ');
  assert.equal(oneSide.rows[0].bank.difference, -1500);
});

test('a reading older than the API sync is compared anyway and labelled "read at different times"', () => {
  const old = buildZohoBankComparison({ reading: reading([screenAccount()], '2026-11-20T10:00:00.000Z'), accounts: [apiAccount()], readStatus: status() });
  assert.deepEqual(old.times, { readAt: '2026-11-20T10:00:00.000Z', syncedAt: SYNC_AT, newer: 'api', apiFiguresEarlier: false, differentTimes: true });
  assert.equal(old.rows[0].differentTimes, true);
  assert.equal(old.rows[0].agrees, true);
  const fresh = buildZohoBankComparison({ reading: reading([screenAccount()]), accounts: [apiAccount()], readStatus: status() });
  assert.equal(fresh.times.newer, 'screen');
  assert.equal(fresh.differentTimes, false);
});

test('no extension reading yet: the API side is shown, nothing is compared', () => {
  const result = buildZohoBankComparison({ reading: null, accounts: [apiAccount()], readStatus: status() });
  assert.equal(result.overall.state, 'no_reading');
  assert.equal(result.rows[0].kind, 'only_api');
  assert.equal(result.rows[0].books.reasonText, 'No extension reading yet');
  assert.equal(result.rows[0].books.api, 1400.25);
});

test('API bank access not granted: every row says "Reconnect Zoho Books to allow bank access"', () => {
  const result = buildZohoBankComparison({ reading: reading([screenAccount()]), accounts: [{ accountID: '900001', name: 'Test Bank Current', bank: null }], readStatus: status(false) });
  assert.equal(result.apiState, 'not_authorized');
  assert.equal(result.overall.state, 'not_authorized');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].bank.status, 'missing');
  assert.equal(result.rows[0].bank.reasonText, 'Reconnect Zoho Books to allow bank access');
  assert.equal(result.rows[0].bank.screen, 1500);
  const never = buildZohoBankComparison({ reading: reading([screenAccount()]), accounts: [], readStatus: null });
  assert.equal(never.overall.state, 'not_synced');
});

test('unmatched accounts are listed "only on screen" / "only in API" and counted as differing; inactive API-only accounts are not', () => {
  const result = buildZohoBankComparison({
    reading: reading([screenAccount(), screenAccount({ accountName: 'Screen Only Account', accountNumber: null })]),
    accounts: [apiAccount(), apiAccount({ accountID: '900003', name: 'Api Only Account' }, { accountNumber: null }),
      apiAccount({ accountID: '900004', name: 'Closed Account' }, { accountNumber: null, isActive: false })],
    readStatus: status(),
  });
  assert.deepEqual(result.rows.map(r => [r.kind, r.accountName]), [
    ['matched', 'Test Bank Current'], ['only_screen', 'Screen Only Account'], ['only_api', 'Api Only Account'], ['only_api', 'Closed Account']]);
  assert.equal(result.rows[1].books.reasonText, 'Only on screen');
  assert.equal(result.rows[2].books.reasonText, 'Only in API');
  assert.equal(result.rows[3].apiInactive, true);
  assert.deepEqual(result.overall, { state: 'differ', total: 3, differ: 2, text: '2 of 3 accounts differ' });
});

test('overall line: "All N accounts agree ✓" when every row agrees', () => {
  const result = buildZohoBankComparison({
    reading: reading([screenAccount(), screenAccount({ accountName: 'Second', accountNumber: 'xxxx0002', amountInBank: 0, uncategorised: 0, amountInBooks: 10 })]),
    accounts: [apiAccount(), apiAccount({ accountID: '900002', name: 'Second' }, { accountNumber: 'xxxx0002', bankBalance: 0, feedsActive: false, uncategorizedCount: 0, bookBalance: 10.004 })],
    readStatus: status(),
  });
  assert.equal(result.overall.text, 'All 2 accounts agree ✓');
});

// ---- the route ----
const ORGS = [
  { id: 1, name: 'Alpha Test Ltd', xero_tenant_id: 'tenant-1' },
  { id: 4, name: 'Zed Test LLC', xero_tenant_id: null, freeagent_company_id: 'zoho-60012345678' },
  { id: 5, name: 'Other Zoho LLC', xero_tenant_id: null, freeagent_company_id: 'zoho-70012345678' },
];
function startApp(session, cacheCalls = []) {
  const app = express();
  app.use((req, res, next) => { req.session = session; next(); });
  app.use('/api/bank-screen/zoho', createZohoBankScreenRouter({
    getAllOrganisations: async () => ORGS,
    getOrganisationByTenantId: async id => ORGS.find(o => o.xero_tenant_id === id || o.freeagent_company_id === id) || null,
    staffHasOrgAccess: async (staffId, orgId) => staffId === 9 && orgId === 4,
    saveZohoReading: async () => 1,
    getLatestZohoReading: async orgId => (orgId === 4 ? reading([screenAccount({ uncategorised: 3 })]) : null),
    getZohoLastReadTimes: async () => new Map(),
    getZohoBooksHosts: async () => new Map(),
    getCachedEntitiesAsync: async (orgId, type) => {
      cacheCalls.push([orgId, type]);
      if (type === 'account') return [apiAccount(), { accountID: '1', name: 'Sales', type: 'REVENUE', bank: null }];
      // Another client's status row must never be taken.
      if (type === 'organisation') return [status(false, SYNC_AT), { ...status(true), organisationID: 'zoho-60012345678' }].reverse();
      return [];
    },
  }));
  return new Promise(resolve => { const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server)); });
}
const get = async (server, url) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bank-screen/zoho${url}`, { headers: { accept: 'application/json' } });
  return { status: response.status, json: await response.json().catch(() => null) };
};

test('GET /zoho/comparison/:tenantId: the staff member\'s Zoho client only; reads the cache, never Zoho', async () => {
  const calls = [];
  const server = await startApp({ staffId: 9, staffRole: 'staff', csrfToken: 'tok' }, calls);
  try {
    const mine = await get(server, '/comparison/zoho-60012345678');
    assert.equal(mine.status, 200);
    assert.equal(mine.json.orgId, '60012345678');
    assert.equal(mine.json.comparison.apiState, 'ok');
    assert.equal(mine.json.comparison.rows.length, 1, 'only accounts with bank details');
    assert.equal(mine.json.comparison.rows[0].uncategorised.status, 'differ');
    assert.equal(mine.json.comparison.overall.text, '1 of 1 account differ');
    assert.deepEqual(calls, [[4, 'account'], [4, 'organisation']]);
    assert.equal((await get(server, '/comparison/zoho-70012345678')).status, 403);
    for (const id of ['tenant-1', 'unknown', 'zoho-1']) assert.equal((await get(server, '/comparison/' + id)).status, 404, id);
    assert.equal(calls.length, 2, 'nothing is read for a client the staff member cannot open');
  } finally { server.close(); }
  const admin = await startApp({ staffId: 1, staffRole: 'admin' });
  try {
    const other = await get(admin, '/comparison/zoho-70012345678');
    assert.equal(other.status, 200);
    assert.equal(other.json.comparison.overall.state, 'no_reading');
  } finally { admin.close(); }
});

// ---- the browser drawing: a tiny stand-in DOM, enough to run public/zohoBankScreen.js and read the text back ----
class FakeNode {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.text = ''; this.style = { cssText: '' }; this.dataset = {}; this.attributes = {}; this.hidden = false; this.listeners = {}; this.parentNode = null; }
  set textContent(value) { this.children = []; this.text = value == null ? '' : String(value); }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child, ref) { child.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, child); return child; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  querySelector(selector) {
    const attr = selector.replace(/^\[|\]$/g, '');
    for (const child of this.children) {
      if (child.attributes[attr] !== undefined) return child;
      const deep = child.querySelector(selector);
      if (deep) return deep;
    }
    return null;
  }
}
// Rows as "a | b | c" lines, blocks as lines: a text picture of what the card shows.
function picture(node) {
  if (node.hidden) return '';
  if (node.tagName === 'TR') return node.children.map(c => cellText(c)).join(' | ') + '\n';
  if (['DIV', 'TABLE', 'THEAD', 'TBODY'].includes(node.tagName)) {
    const inner = node.text + node.children.map(picture).join('');
    return inner && !inner.endsWith('\n') ? inner + '\n' : inner;
  }
  return node.text + node.children.map(picture).join('');
}
function cellText(td) {
  return (td.text + td.children.map(c => (c.tagName === 'DIV' ? ' ' : '') + c.textContent.trim()).join(' ')).replace(/\s+/g, ' ').trim();
}

async function drawCard(latest, comparison) {
  const body = new FakeNode('div'); body.setAttribute('data-zoho-bank-screen-body', '');
  const button = new FakeNode('button'); button.setAttribute('data-zoho-bank-screen-update', '');
  const note = new FakeNode('div'); note.setAttribute('data-zoho-bank-screen-note', '');
  const card = new FakeNode('div');
  card.dataset = { basePath: '/akrio-verify', tenantId: 'zoho-60012345678', csrf: 'tok' };
  for (const n of [button, note]) card.appendChild(n);
  card.appendChild(body);
  const answers = { latest, comparison };
  const fetched = [];
  const context = {
    window: { addEventListener() {}, postMessage() {}, location: { origin: 'http://x' } },
    document: { createElement: tag => new FakeNode(tag), querySelectorAll: s => (s === '[data-zoho-bank-screen-card]' ? [card] : []) },
    Node: FakeNode, fetch: async url => {
      fetched.push(url);
      const body = /\/comparison\//.test(url) ? answers.comparison : answers.latest;
      return { ok: true, status: 200, redirected: false, url, headers: { get: () => 'application/json' }, json: async () => body };
    },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise, Map, String, Math, Number, Error, JSON, encodeURIComponent,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/zohoBankScreen.js'), 'utf8'), context);
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  return { text: picture(body), body, fetched };
}

// The fixture used for the sample in the report: four accounts, one of each kind of row.
const FIXTURE_READING = reading([
  screenAccount({ accountName: 'Sample Bank Current', accountNumber: 'xxxx0002', currency: 'AED', amountInBank: 1250, amountInBooks: 98765.43, uncategorised: 1 }),
  screenAccount({ accountName: 'Sample Bank USD', accountNumber: 'xxxx0001', currency: '$', amountInBank: 0, amountInBooks: -12345.67, uncategorised: 0 }),
  screenAccount({ accountName: 'Sample Credit Card <b>x</b>', accountNumber: 'xxxx0000', currency: 'AED', amountInBank: -2000, amountInBooks: -2150.25, uncategorised: 3 }),
  screenAccount({ accountName: 'Petty Cash', accountNumber: null, currency: 'AED', amountInBank: 0, amountInBooks: 1048.59, uncategorised: 0 }),
], '2026-11-24T09:00:00.000Z');
const FIXTURE_ACCOUNTS = [
  apiAccount({ accountID: 'b1', name: 'Sample Bank Current' }, { accountNumber: 'xxxx0002', bookBalance: 98765.43, bankBalance: 1250, uncategorizedCount: 1 }),
  apiAccount({ accountID: 'b2', name: 'sample bank  usd', currencyCode: 'USD' }, { currencyCode: 'USD', accountNumber: 'xxxx0001', bookBalance: -12345.67, bookBalanceBase: -45339.47, bankBalance: 0, uncategorizedCount: 0, feedsActive: false }),
  apiAccount({ accountID: 'b3', name: 'Sample Credit Card <b>x</b>' }, { accountType: 'credit_card', accountNumber: 'xxxx0000', bookBalance: -2100.25, bankBalance: -2000, uncategorizedCount: 1 }),
  apiAccount({ accountID: 'b5', name: 'Sample Deposit' }, { accountNumber: 'xxxx0005', bookBalance: 500, bankBalance: 500, uncategorizedCount: 0 }),
];

test('the card draws the comparison table with text only (no markup from the data), and the overall line', async () => {
  const comparison = buildZohoBankComparison({ reading: FIXTURE_READING, accounts: FIXTURE_ACCOUNTS, readStatus: status() });
  const latest = { orgId: '60012345678', booksHost: 'books.zoho.com', staleAfterDays: 7,
    reading: { ...FIXTURE_READING, readAt: FIXTURE_READING.readAt.toISOString(), freshness: 'current', uncategorisedTotal: 4, summaryDiffers: false,
      accounts: FIXTURE_READING.accounts.map(a => ({ ...a, bankFeed: a.amountInBank === 0 ? 'not_available' : 'shown', difference: a.amountInBank === 0 ? null : a.amountInBooks - a.amountInBank })) } };
  const { text, fetched } = await drawCard(latest, { orgId: '60012345678', comparison: JSON.parse(JSON.stringify(comparison)) });
  assert.deepEqual(fetched, ['/akrio-verify/api/bank-screen/zoho/latest/zoho-60012345678', '/akrio-verify/api/bank-screen/zoho/comparison/zoho-60012345678']);
  const table = text.slice(text.indexOf('Zoho Books screen compared'));
  if (process.env.SHOW_ZOHO_COMPARISON) console.log(table);
  assert.match(table, /Bank account \| Amount in Zoho Books \| Amount in Bank \| Uncategorised/);
  assert.match(table, /Sample Bank Current xxxx0002 \| Screen AED98,765.43 API AED98,765.43 ✓ \| Screen AED1,250.00 API AED1,250.00 ✓ \| Screen 1 API 1 ✓/);
  assert.match(table, /Sample Bank USD xxxx0001 \| Screen \(\$12,345.67\) API \(USD12,345.67\) ✓ \| No bank feed ✓ \| Screen 0 API 0 ✓/);
  assert.match(table, /Sample Credit Card <b>x<\/b> xxxx0000 \| Screen \(AED2,150.25\) API \(AED2,100.25\) ✗ \(AED50.00\) \| Screen \(AED2,000.00\) API \(AED2,000.00\) ✓ \| Screen 3 API 1 ✗ \+2/);
  assert.match(table, /Petty Cash Only on screen \| Screen AED1,048.59 API — — Only on screen/);
  assert.match(table, /Sample Deposit xxxx0005 Only in API \| Screen — API AED500.00 — Only in API/);
  assert.match(table, /3 of 5 accounts differ/);
  assert.match(table, /the screen reading is newer/);
});

test('the card shows the reconnect message when Zoho\'s API has no bank access, and a stale reading is labelled', async () => {
  const blocked = buildZohoBankComparison({ reading: FIXTURE_READING, accounts: [], readStatus: status(false) });
  const latest = { orgId: '60012345678', booksHost: 'books.zoho.com', staleAfterDays: 7, reading: null };
  const one = await drawCard(latest, { comparison: JSON.parse(JSON.stringify(blocked)) });
  assert.match(one.text, /Reconnect Zoho Books to allow bank access/);
  const old = buildZohoBankComparison({ reading: reading([screenAccount()], '2026-11-20T10:00:00.000Z'), accounts: [apiAccount()], readStatus: status() });
  const two = await drawCard(latest, { comparison: JSON.parse(JSON.stringify(old)) });
  assert.match(two.text, /Read at different times/);
  assert.match(two.text, /the API sync is newer/);
  assert.match(two.text, /All 1 account agree ✓/);
});

test('the browser script never writes HTML from data', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/zohoBankScreen.js'), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

// ---- review fixes ----
const notRead = (reason = 'daily_limit', readAt = SYNC_AT) => ({ organisationID: 'zoho-60012345678', ledger: 'zoho', readAt,
  permissions: { banking: null, expenses: true }, sections: { banking: { read: false, reason } } });

test('banking not read at the last sync (daily limit / error) and nothing cached: grey reason, not "differ"', () => {
  for (const reason of ['daily_limit', 'error']) {
    const result = buildZohoBankComparison({
      reading: reading([screenAccount(), screenAccount({ accountName: 'Other', accountNumber: 'xxxx0009' })]),
      accounts: [{ accountID: '900001', name: 'Test Bank Current', type: 'BANK', bank: null }],
      readStatus: notRead(reason),
    });
    assert.equal(result.apiState, 'not_read');
    assert.equal(result.overall.state, 'not_read');
    assert.doesNotMatch(result.overall.text, /differ/);
    assert.match(result.overall.text, /not read at the last sync/);
    assert.equal(result.rows.length, 2);
    for (const row of result.rows) {
      assert.equal(row.kind, 'only_screen');
      assert.equal(row.books.status, 'missing');
      assert.equal(row.books.reason, 'not_read');
      assert.match(row.books.reasonText, /not read at the last sync/);
    }
  }
  const limit = buildZohoBankComparison({ reading: reading([screenAccount()]), accounts: [], readStatus: notRead('daily_limit') });
  assert.match(limit.overall.text, /daily API limit/);
});

test('banking not read at the last sync but older bank figures cached: compared, marked earlier sync, time not taken from the sync', () => {
  // Screen read after the sync: the API figures are older still, so the screen is newer, and the times differ.
  const after = buildZohoBankComparison({ reading: reading([screenAccount()]), accounts: [apiAccount({}, { stale: false })], readStatus: notRead('error') });
  assert.equal(after.apiState, 'ok');
  assert.equal(after.times.apiFiguresEarlier, true);
  assert.equal(after.differentTimes, true);
  assert.equal(after.rows[0].apiStale, true);
  assert.equal(after.rows[0].differentTimes, true);
  assert.equal(after.overall.text, 'All 1 account agree ✓');
  // Screen read before the sync: when the API bank figures were taken is unknown, so neither is called newer.
  const before = buildZohoBankComparison({ reading: reading([screenAccount()], '2026-11-23T09:00:00.000Z'), accounts: [apiAccount({}, { stale: true })], readStatus: notRead('error') });
  assert.equal(before.times.newer, null);
  assert.equal(before.differentTimes, true);
  // Banking read normally: unchanged behaviour.
  const normal = buildZohoBankComparison({ reading: reading([screenAccount()]), accounts: [apiAccount()], readStatus: { ...status(), sections: { banking: { read: true } } } });
  assert.equal(normal.times.apiFiguresEarlier, false);
  assert.equal(normal.times.newer, 'screen');
  assert.equal(normal.differentTimes, false);
});

test('half a cent is a difference: |difference| must be below 0.005 (no floating-point slack)', () => {
  assert.equal(compareAmount(100.005, 100).status, 'differ');
  assert.equal(compareAmount(100.005, 100).difference, 0.005);
  assert.equal(compareAmount(100, 100.005).status, 'differ');
  assert.equal(compareAmount(-0.005, 0).status, 'differ');
  assert.equal(compareAmount(100.004, 100).status, 'equal');
  assert.equal(compareAmount(0.1 + 0.2, 0.3).status, 'equal');
  assert.equal(compareAmount(1400.25, 1400.24).status, 'differ');
});

test('two screen accounts with the same name and nothing to tell them apart are not paired with one API account', () => {
  const api = apiBankAccounts([apiAccount({ accountID: '9', name: 'x' }, { accountNumber: null })]);
  const both = matchAccounts([{ accountName: 'X' }, { accountName: 'X' }], api);
  assert.equal(both.pairs.length, 0);
  assert.equal(both.onlyScreen.length, 2);
  assert.equal(both.onlyApi.length, 1);
  // A number on one screen account settles it.
  const api2 = apiBankAccounts([apiAccount({ accountID: '9', name: 'x' }, { accountNumber: 'xxxx0001' })]);
  const settled = matchAccounts([{ accountName: 'X', accountNumber: 'xxxx0002' }, { accountName: 'X', accountNumber: 'xxxx0001' }], api2);
  assert.equal(settled.pairs.length, 1);
  assert.equal(settled.pairs[0].screen.accountNumber, 'xxxx0001');
});

test('the card explains bank figures not read at the last sync, and figures from an earlier sync', async () => {
  const latest = { orgId: '60012345678', booksHost: 'books.zoho.com', staleAfterDays: 7, reading: null };
  const none = buildZohoBankComparison({ reading: reading([screenAccount()]), accounts: [], readStatus: notRead('daily_limit') });
  const one = await drawCard(latest, { comparison: JSON.parse(JSON.stringify(none)) });
  assert.match(one.text, /not read at the last sync/);
  assert.doesNotMatch(one.text, /accounts? differ/);
  const earlier = buildZohoBankComparison({ reading: reading([screenAccount()], '2026-11-23T09:00:00.000Z'), accounts: [apiAccount()], readStatus: notRead('error') });
  const two = await drawCard(latest, { comparison: JSON.parse(JSON.stringify(earlier)) });
  assert.match(two.text, /API bank figures: from an earlier sync \(time unknown\)/);
  assert.match(two.text, /Read at different times/);
  assert.doesNotMatch(two.text, /the screen reading is newer|the API sync is newer/);
});

test('an account with a bank feed ("xxxx1234 | Updated on: 26 Nov 2026" on the screen) pairs with its API account by the real number', () => {
  const { buildZohoBankComparison } = require('../src/services/zohoBankComparison');
  const mapping = require('../src/services/ledgers/zoho/mapping');
  const names = ['Made Up Co 1111', 'Made Up Co 2222'];
  const accounts = mapping.mergeBankAccounts(names.map((n, i) => mapping.mapAccount({ account_id: 'b' + i, account_name: 'Made Up Co', account_type: 'bank', is_active: true })),
    names.map((n, i) => ({ account_id: 'b' + i, account_name: 'Made Up Co', account_type: 'bank', account_number: 'xxxx' + n.slice(-4), currency_code: 'AED', balance: 100 * (i + 1), bcy_balance: 100 * (i + 1), bank_balance: 0, uncategorized_transactions: 0, is_active: true })));
  const reading = { readAt: new Date().toISOString(), accounts: names.map((n, i) => ({ accountName: 'Made Up Co', accountNumber: 'xxxx' + n.slice(-4) + ' | Updated on: 26 Nov 2026', currency: 'AED', uncategorised: 0, amountInBank: 0, amountInBooks: 100 * (i + 1) })) };
  const result = buildZohoBankComparison({ reading, accounts, readStatus: { readAt: new Date().toISOString(), permissions: { banking: true } } });
  assert.equal(result.onlyScreenCount, 0);
  assert.equal(result.onlyApiCount, 0);
  assert.ok(result.rows.every(r => r.kind === 'matched' && r.agrees), JSON.stringify(result.rows.map(r => [r.kind, r.accountNumber])));
  assert.equal(result.rows[0].accountNumber, 'xxxx1111');
});
