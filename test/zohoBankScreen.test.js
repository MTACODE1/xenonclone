// The browser extension reading Zoho Books' Banking page, and Verify receiving and showing those readings. The page
// fixture is shaped like Zoho's live Banking page (24 Nov 2026) with every name and figure invented. The last tests
// prove the Xero readings are handled exactly as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const zoho = require('../extension/zoho-parser');
const { validateZohoReading, presentZohoReading, bankFeedOf, booksHostFromApiDomain } = require('../src/services/zohoBankScreenReading');
const { ReadingError, validateReading, buildShortCodeIndex } = require('../src/services/bankScreenReading');
const { saveZohoReading, getLatestZohoReading } = require('../src/db/zohoBankScreenReadings');
const { createZohoBankScreenRouter, zohoOrgIdOf } = require('../src/routes/zohoBankScreen');
const { createBankScreenRouter } = require('../src/routes/bankScreen');

const PAGE = fs.readFileSync(path.join(__dirname, 'fixtures/zoho/banking-page.html'), 'utf8');
const TABLE = PAGE.slice(PAGE.indexOf('<table'), PAGE.indexOf('</table>') + '</table>'.length);

// ---- parsing the page ----
test('the saved Banking page parses into one account per row, figures as Zoho shows them', () => {
  const { accounts, problems } = zoho.parseBankingTable(TABLE);
  assert.deepEqual(problems, []);
  const pick = a => [a.accountName, a.accountNumber, a.uncategorised, a.amountInBank, a.amountInBooks, a.currency];
  assert.deepEqual(accounts.map(pick), [
    // empty Uncategorized cell (an Ember comment only), $ prefix, minus after the currency, zero bank amount
    ['Sample Bank - USD Account', 'xxxx0001', 0, 0, -12345.67, '$'],
    // singular "1 transaction", a real bank amount
    ['Sample Bank Current Acct -AED', 'xxxx0002', 1, 1250, 98765.43, 'AED'],
    // plural, HTML entity in the name, negative ledger balance
    ['Sample Savings & Deposits', 'xxxx0003', 12, 0, -500, 'AED'],
    // no masked number, truly empty cell
    ['Petty Cash', null, 0, 0, 1048.59, 'AED'],
    // negative bank amount (a credit card)
    ['Sample Credit Card 0000***0000', 'xxxx0000', 3, -2000, -2150.25, 'AED'],
  ]);
  assert.equal(accounts[0].amountInBooksText, '$-12,345.67');
  assert.equal(zoho.parseSummaryTotal(zoho.textOf(PAGE)), 16);
});

test('Zoho amounts: currency prefix, sign before or after it, brackets; anything else is null, never 0', () => {
  const read = value => { const parsed = zoho.parseZohoAmount(value); return parsed && [parsed.amount, parsed.currency]; };
  assert.deepEqual(read('$-55,254.31'), [-55254.31, '$']);
  assert.deepEqual(read('AED895,408.35'), [895408.35, 'AED']);
  assert.deepEqual(read('AED0.00'), [0, 'AED']);
  assert.ok(Object.is(read('AED-0.00')[0], 0));
  assert.deepEqual(read('-$1.50'), [-1.5, '$']);
  assert.deepEqual(read('(AED1.00)'), [-1, 'AED']);
  assert.deepEqual(read('AED 1,000.00'), [1000, 'AED']);
  assert.deepEqual(read('₹8,95,408.35'), [895408.35, '₹']);
  assert.deepEqual(read('BHD1.250'), [1.25, 'BHD']);
  assert.deepEqual(read('US$12.00'), [12, 'US$']);
  assert.deepEqual(read('12.00'), [12, null]);
  for (const junk of [null, undefined, '', 'AED', '1.234,56', '12,34.00', '--1.00', '-AED-1.00', '(AED1.00', 'AED1.2345', 'Loading…', '<b>1</b>']) {
    assert.equal(zoho.parseZohoAmount(junk), null, String(junk));
  }
});

test('Zoho euro amounts with a decimal comma ("€89,05", "€1.234,56") are read; other comma decimals still are not', () => {
  const read = value => { const parsed = zoho.parseZohoAmount(value); return parsed && [parsed.amount, parsed.currency]; };
  assert.deepEqual(read('€89,05'), [89.05, '€']);
  assert.deepEqual(read('€0,00'), [0, '€']);
  assert.deepEqual(read('€1.234,56'), [1234.56, '€']);
  assert.deepEqual(read('€-61,38'), [-61.38, '€']);
  assert.deepEqual(read('EUR 12.345,6'), [12345.6, 'EUR']);
  assert.deepEqual(read('€1,234.56'), [1234.56, '€'], 'the English form still reads');
  for (const text of ['AED98.765,43', '1.234,56', '89,05', '€1.23,45']) assert.equal(zoho.parseZohoAmount(text), null, text);
});

test('the Uncategorized cell: empty is none, "1 transaction" and "n transactions" are counts, anything else unknown', () => {
  assert.equal(zoho.parseUncategorised(''), 0);
  assert.equal(zoho.parseUncategorised('<!---->'), 0);
  assert.equal(zoho.parseUncategorised('<a class="uncat-txn">1 transaction</a>'), 1);
  assert.equal(zoho.parseUncategorised('1 transactions'), 1);
  assert.equal(zoho.parseUncategorised('1,204 transactions'), 1204);
  assert.equal(zoho.parseUncategorised('Loading'), null);
  assert.equal(zoho.parseUncategorised('-3 transactions'), null);
});

test('a changed table is refused: renamed column, unreadable amount or count, missing name', () => {
  assert.deepEqual(zoho.parseBankingTable(TABLE.replace('Amount in Bank', 'Bank Balance')).problems, ['column_bank']);
  // A European-format figure is not a changed page: it gets its own code (see the unsupported-format test).
  assert.deepEqual(zoho.parseBankingTable(TABLE.replace('AED98,765.43', 'AED98.765,43')).problems, ['Sample Bank Current Acct -AED: amount_format']);
  assert.deepEqual(zoho.parseBankingTable(TABLE.replace('AED98,765.43', 'AED--')).problems, ['Sample Bank Current Acct -AED: amount_in_books']);
  assert.deepEqual(zoho.parseBankingTable(TABLE.replace('12 transactions', 'some transactions')).problems, ['Sample Savings & Deposits: uncategorised']);
  assert.deepEqual(zoho.parseBankingTable(TABLE.replace('>Petty Cash<', '><')).problems, ['Row 4: account_name']);
  assert.deepEqual(zoho.parseBankingTable('<table><tr><td>x</td></tr></table>').problems,
    ['column_details', 'column_uncategorised', 'column_bank', 'column_books']);
});

test('amounts in a number or currency format not supported yet are told apart from a changed page', () => {
  for (const text of ['AED98.765,43', '1.000,00 €', '\u062f.\u06251,000.00', '\u20b11,000.00', '1,000.00 \u20ac', '1,000.00 AED']) {
    assert.equal(zoho.parseZohoAmount(text), null, text);
    assert.equal(zoho.isUnsupportedAmountFormat(text), true, text);
  }
  for (const text of ['AED895,408.35', '$-55,254.31', '', 'AED--', 'n/a']) assert.equal(zoho.isUnsupportedAmountFormat(text), false, text);
});

test('Zoho addresses: data centres, sign-in pages, organisation id in the path, Banking in the hash', () => {
  assert.equal(zoho.bankingUrl('books.zoho.com', '60012345678'), 'https://books.zoho.com/app/60012345678#/banking');
  assert.equal(zoho.orgIdFromPath('/app/60012345678'), '60012345678');
  assert.equal(zoho.orgIdFromPath('/app/60012345678/'), '60012345678');
  for (const bad of ['/app/abc', '/app/600/extra', '/app/', '/books/60012345678']) assert.equal(zoho.orgIdFromPath(bad), null);
  assert.equal(zoho.isBankingHash('#/banking'), true);
  assert.equal(zoho.isBankingHash('#/banking?filter=active'), true);
  assert.equal(zoho.isBankingHash('#/banking/12345/transactions'), false);
  assert.equal(zoho.isBankingHash('#/home/dashboard'), false);
  for (const host of ['books.zoho.com', 'books.zoho.eu', 'books.zoho.in', 'books.zohocloud.ca', 'BOOKS.ZOHO.COM']) assert.equal(zoho.isBooksHost(host), true, host);
  for (const host of ['books.zoho.com.evil.test', 'zoho.com', 'books.zohoo.com', '']) assert.equal(zoho.isBooksHost(host), false, host);
  assert.equal(zoho.isZohoSignInHost('accounts.zoho.eu'), true);
  assert.equal(zoho.isZohoSignInHost('accounts.zoho.eu.evil.test'), false);
  assert.equal(zoho.isZohoOrgId('60012345678'), true);
  for (const bad of [60012345678, '6001234567a', '../1', '1234', '']) assert.equal(zoho.isZohoOrgId(bad), false, String(bad));
});

// ---- validation and display rules ----
const zohoAccount = extra => ({ accountName: 'Main', accountNumber: 'xxxx0001', uncategorised: 2, currency: 'AED',
  amountInBank: 100.005, amountInBooks: 90, ...extra });
const zohoBody = extra => ({ orgId: '60012345678', booksHost: 'books.zoho.com', pageTitle: ' Banking ', summaryTotal: 2,
  accounts: [zohoAccount()], ...extra });

test('validateZohoReading keeps only known fields and rounds amounts to three decimals', () => {
  const clean = validateZohoReading(zohoBody({ tenantId: 'zoho-60012345678', extra: 'x', accounts: [zohoAccount({ evil: '<script>', amountInBooksText: 'x' })] }));
  assert.deepEqual(Object.keys(clean), ['orgId', 'booksHost', 'pageTitle', 'summaryTotal', 'accounts']);
  assert.deepEqual(clean.accounts[0], { accountName: 'Main', accountNumber: 'xxxx0001', uncategorised: 2, currency: 'AED', amountInBank: 100.005, amountInBooks: 90 });
  assert.equal(clean.pageTitle, 'Banking');
  assert.equal(validateZohoReading(zohoBody({ booksHost: null, summaryTotal: undefined })).booksHost, null);
  assert.equal(validateZohoReading(zohoBody({ accounts: [zohoAccount({ amountInBank: 1.23456 })] })).accounts[0].amountInBank, 1.235);
});

test('validateZohoReading refuses malformed or hostile readings', () => {
  const bad = [
    null, [], 'x', {}, zohoBody({ orgId: 60012345678 }), zohoBody({ orgId: '600-123' }), zohoBody({ orgId: '1'.repeat(21) }),
    zohoBody({ booksHost: 'evil.example' }), zohoBody({ accounts: [] }), zohoBody({ accounts: {} }),
    zohoBody({ accounts: Array.from({ length: 61 }, () => zohoAccount()) }), zohoBody({ summaryTotal: -1 }), zohoBody({ summaryTotal: '2' }),
    zohoBody({ pageTitle: 'x'.repeat(201) }), zohoBody({ accounts: [null] }),
    zohoBody({ accounts: [zohoAccount({ accountName: '' })] }), zohoBody({ accounts: [zohoAccount({ accountName: 'x'.repeat(256) })] }),
    zohoBody({ accounts: [zohoAccount({ accountNumber: 'x'.repeat(65) })] }),
    zohoBody({ accounts: [zohoAccount({ uncategorised: null })] }), zohoBody({ accounts: [zohoAccount({ uncategorised: 1.5 })] }),
    zohoBody({ accounts: [zohoAccount({ uncategorised: '3' })] }), zohoBody({ accounts: [zohoAccount({ amountInBank: '1.00' })] }),
    zohoBody({ accounts: [zohoAccount({ amountInBank: null })] }), zohoBody({ accounts: [zohoAccount({ amountInBooks: Infinity })] }),
    zohoBody({ accounts: [zohoAccount({ amountInBooks: 1e13 })] }), zohoBody({ accounts: [zohoAccount({ currency: '<b>' })] }),
    zohoBody({ accounts: [zohoAccount({ currency: 'ABCDEFG' })] }),
  ];
  for (const body of bad) assert.throws(() => validateZohoReading(body), ReadingError, JSON.stringify(body)?.slice(0, 100));
});

test('no-feed rule: Amount in Bank 0.00 is "not available", never a difference; otherwise Books minus Bank', () => {
  assert.deepEqual(bankFeedOf({ amountInBank: 0, amountInBooks: -12345.67 }), { state: 'not_available', difference: null });
  assert.deepEqual(bankFeedOf({ amountInBank: 1250, amountInBooks: 98765.43 }), { state: 'shown', difference: 97515.43 });
  assert.deepEqual(bankFeedOf({ amountInBank: -2000, amountInBooks: -2150.25 }), { state: 'shown', difference: -150.25 });
  assert.deepEqual(bankFeedOf({ amountInBank: 10.1, amountInBooks: 10.1 }), { state: 'shown', difference: 0 });
});

test('a reading over seven days old is shown as stale; the rows are checked against Zoho\'s own total', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const reading = { readAt: new Date('2026-11-16T11:00:00Z'), summaryTotal: 16, accounts: [
    { accountName: 'A', uncategorised: 1, amountInBank: 0, amountInBooks: 5 },
    { accountName: 'B', uncategorised: 3, amountInBank: 7, amountInBooks: 5 },
  ] };
  const shown = presentZohoReading(reading, now);
  assert.equal(shown.freshness, 'stale');
  assert.equal(shown.uncategorisedTotal, 4);
  assert.equal(shown.summaryDiffers, true);
  assert.deepEqual(shown.accounts.map(a => [a.bankFeed, a.difference]), [['not_available', null], ['shown', -2]]);
  assert.equal(presentZohoReading({ ...reading, readAt: new Date('2026-11-20T12:00:00Z'), summaryTotal: 4 }, now).freshness, 'current');
  assert.equal(presentZohoReading({ ...reading, summaryTotal: 4 }, now).summaryDiffers, false);
  assert.equal(presentZohoReading(null), null);
});

test('the Books address of each data centre comes from the API domain Zoho named', () => {
  assert.equal(booksHostFromApiDomain('https://www.zohoapis.com'), 'books.zoho.com');
  assert.equal(booksHostFromApiDomain('https://www.zohoapis.eu'), 'books.zoho.eu');
  assert.equal(booksHostFromApiDomain('https://www.zohoapis.ca'), 'books.zohocloud.ca');
  assert.equal(booksHostFromApiDomain('https://zohoapis.com.au/'), 'books.zoho.com.au');
  for (const bad of [null, '', 'http://www.zohoapis.com', 'https://www.zohoapis.com.evil.test', 'https://evil.test']) assert.equal(booksHostFromApiDomain(bad), null);
});

// ---- storage ----
function fakePool({ failOn = null } = {}) {
  const log = [];
  const connection = {
    beginTransaction: async () => log.push('begin'),
    query: async (sql, params) => {
      if (failOn && sql.includes(failOn)) throw new Error('insert failed');
      log.push([sql.replace(/\s+/g, ' ').trim().slice(0, 50), params]);
      return [{ insertId: 88 }];
    },
    commit: async () => log.push('commit'), rollback: async () => log.push('rollback'), release: () => log.push('release'),
  };
  return { log, getConnection: async () => connection };
}

test('saveZohoReading writes the batch and its accounts together, or nothing', async () => {
  const pool = fakePool();
  const reading = validateZohoReading(zohoBody({ accounts: [zohoAccount(), zohoAccount({ accountName: 'Second', amountInBank: 0 })] }));
  assert.equal(await saveZohoReading(5, reading, { id: 9, name: 'Tester' }, { pool, ensure: async () => {} }), 88);
  assert.deepEqual(pool.log[1][1], [5, '60012345678', 'books.zoho.com', 'Banking', 2, 2, 9, 'Tester']);
  assert.match(pool.log[1][0], /akrio_zoho_bank_screen_batches/);
  assert.deepEqual(pool.log[2][1][0][1], [88, 5, 1, 'Second', 'xxxx0001', 2, 'AED', 0, 90]);
  assert.deepEqual(pool.log.slice(3), ['commit', 'release']);
  const failing = fakePool({ failOn: 'akrio_zoho_bank_screen_accounts' });
  await assert.rejects(saveZohoReading(5, reading, {}, { pool: failing, ensure: async () => {} }), /insert failed/);
  assert.deepEqual(failing.log.slice(-2), ['rollback', 'release']);
  await assert.rejects(saveZohoReading(undefined, reading, {}, { pool, ensure: async () => {} }), /organisation id/);
});

test('getLatestZohoReading returns the newest batch with numbers as numbers', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push(params);
    if (sql.includes('akrio_zoho_bank_screen_batches')) return [[{ id: 3, zoho_org_id: '60012345678', books_host: 'books.zoho.com', page_title: 'T', summary_total: '4', read_by_name: 'A', read_at_unix: '1795082400' }]];
    return [[{ account_name: 'Main', account_number: null, uncategorised: '4', currency: 'AED', amount_in_bank: '0.000', amount_in_books: '-10.500' }]];
  } };
  const latest = await getLatestZohoReading(5, { pool, ensure: async () => {} });
  assert.deepEqual(calls, [[5], [3, 5]]);
  assert.equal(latest.readAt.toISOString(), '2026-11-19T10:00:00.000Z');
  assert.equal(latest.summaryTotal, 4);
  assert.deepEqual(latest.accounts[0], { accountName: 'Main', accountNumber: null, uncategorised: 4, currency: 'AED', amountInBank: 0, amountInBooks: -10.5 });
  assert.equal(await getLatestZohoReading(6, { pool: { query: async () => [[]] }, ensure: async () => {} }), null);
});

// ---- routes, with fake data access and a fake session, mounted as app.js mounts them ----
const ORGS = [
  { id: 1, name: 'Alpha Test Ltd', xero_tenant_id: 'tenant-1' },
  { id: 4, name: 'Zed Test LLC', xero_tenant_id: null, freeagent_company_id: 'zoho-60012345678' },
  { id: 5, name: 'Other Zoho LLC', xero_tenant_id: null, freeagent_company_id: 'zoho-70012345678' },
  { id: 6, name: 'FreeAgent Test Ltd', xero_tenant_id: null, freeagent_company_id: '35963' },
  { id: 7, name: 'QuickBooks Test Inc', xero_tenant_id: null, freeagent_company_id: 'qbo-9130354851' },
];
const byIdentifier = id => ORGS.find(o => o.xero_tenant_id === id || o.freeagent_company_id === id) || null;
function startApp(session, { zohoSaved = [], xeroSaved = [], latest = null } = {}) {
  const app = express();
  app.use((req, res, next) => { req.session = session; next(); });
  const shared = {
    getAllOrganisations: async () => ORGS,
    getOrganisationById: async id => ORGS.find(o => o.id === id) || null,
    getOrganisationByTenantId: async id => byIdentifier(id),
    staffHasOrgAccess: async (staffId, orgId) => staffId === 9 && (orgId === 1 || orgId === 4),
  };
  app.use('/api/bank-screen/zoho', createZohoBankScreenRouter({
    ...shared,
    saveZohoReading: async (orgId, reading, staff) => { zohoSaved.push({ orgId, reading, staff }); return 51; },
    getLatestZohoReading: async orgId => (orgId === 4 ? latest : null),
    getZohoLastReadTimes: async () => new Map([[4, new Date('2026-11-19T10:00:00Z')]]),
    getZohoBooksHosts: async () => new Map([['60012345678', 'books.zoho.eu']]),
  }));
  app.use('/api/bank-screen', createBankScreenRouter({
    ...shared,
    getShortCodeIndex: async () => buildShortCodeIndex([{ orgId: 1, shortCode: '!alpha' }]),
    saveReading: async (orgId, reading, staff) => { xeroSaved.push({ orgId, reading, staff }); return 41; },
    getLastReadTimes: async () => new Map(),
    getActiveBankAccountCount: async () => 0,
    getLatestReading: async () => null,
  }));
  return new Promise(resolve => { const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server)); });
}
async function call(server, method, path, { body, csrf } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrf) headers['x-csrf-token'] = csrf;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bank-screen${path}`, {
    method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}
const staff = { staffId: 9, staffName: 'Tester', staffRole: 'staff', csrfToken: 'tok' };

test('POST /zoho/readings saves for the client whose Zoho organisation id it is', async () => {
  const zohoSaved = [];
  const server = await startApp(staff, { zohoSaved });
  try {
    const ok = await call(server, 'POST', '/zoho/readings', { body: zohoBody({ tenantId: 'zoho-60012345678' }), csrf: 'tok' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true, batchId: 51, name: 'Zed Test LLC', accounts: 1, checksUpdated: false, checksUpdateAt: 'next_sync' });
    assert.equal(zohoSaved.length, 1);
    assert.equal(zohoSaved[0].orgId, 4);
    assert.deepEqual(zohoSaved[0].staff, { id: 9, name: 'Tester' });
    assert.equal(zohoSaved[0].reading.accounts[0].amountInBank, 100.005);
  } finally { server.close(); }
});

test('POST /zoho/readings refuses: no token, wrong token, bad body, unknown org, no access, wrong client', async () => {
  const zohoSaved = [];
  const server = await startApp(staff, { zohoSaved });
  try {
    assert.equal((await call(server, 'POST', '/zoho/readings', { body: zohoBody() })).status, 403);
    assert.equal((await call(server, 'POST', '/zoho/readings', { body: zohoBody(), csrf: 'nope' })).status, 403);
    assert.equal((await call(server, 'POST', '/zoho/readings', { body: zohoBody({ orgId: '60012345678; DROP' }), csrf: 'tok' })).status, 400);
    assert.equal((await call(server, 'POST', '/zoho/readings', { body: zohoBody({ accounts: [zohoAccount({ amountInBank: '1e400' })] }), csrf: 'tok' })).status, 400);
    assert.equal((await call(server, 'POST', '/zoho/readings', { body: '{"orgId":', csrf: 'tok' })).status, 400);
    assert.equal((await call(server, 'POST', '/zoho/readings', { body: zohoBody({ orgId: '99912345678' }), csrf: 'tok' })).status, 404);
    // Staff member 9 has no access to the other Zoho client.
    assert.equal((await call(server, 'POST', '/zoho/readings', { body: zohoBody({ orgId: '70012345678' }), csrf: 'tok' })).status, 403);
    // The page was on a different client than the Zoho organisation that was read.
    assert.equal((await call(server, 'POST', '/zoho/readings', { body: zohoBody({ tenantId: 'tenant-1' }), csrf: 'tok' })).status, 409);
    // A body far over the size limit is refused before it is read.
    const huge = zohoBody({ pageTitle: 'x'.repeat(300000) });
    assert.equal((await call(server, 'POST', '/zoho/readings', { body: huge, csrf: 'tok' })).status, 413);
    assert.equal(zohoSaved.length, 0);
  } finally { server.close(); }
  const noToken = await startApp({ staffId: 9, staffRole: 'staff' });
  try {
    assert.equal((await call(noToken, 'POST', '/zoho/readings', { body: zohoBody() })).status, 403);
  } finally { noToken.close(); }
});

test('GET /zoho/organisations and /zoho/latest cover only Zoho clients the staff member can access', async () => {
  const latest = { batchId: 1, readAt: new Date(), readByName: 'T', summaryTotal: null,
    accounts: [{ accountName: 'Main', accountNumber: null, uncategorised: 0, currency: 'AED', amountInBank: 0, amountInBooks: 5 }] };
  const server = await startApp(staff, { latest });
  try {
    const list = await call(server, 'GET', '/zoho/organisations');
    assert.deepEqual(list.json.organisations, [{ tenantId: 'zoho-60012345678', name: 'Zed Test LLC', orgId: '60012345678',
      booksHost: 'books.zoho.eu', lastReadAt: '2026-11-19T10:00:00.000Z' }]);
    const mine = await call(server, 'GET', '/zoho/latest/zoho-60012345678');
    assert.equal(mine.status, 200);
    assert.equal(mine.json.orgId, '60012345678');
    assert.equal(mine.json.booksHost, 'books.zoho.eu');
    assert.equal(mine.json.staleAfterDays, 7);
    assert.equal(mine.json.reading.freshness, 'current');
    assert.equal(mine.json.reading.accounts[0].bankFeed, 'not_available');
    assert.equal((await call(server, 'GET', '/zoho/latest/zoho-70012345678')).status, 403);
    // A Xero, FreeAgent or QuickBooks client is not a Zoho client.
    for (const id of ['tenant-1', '35963', 'qbo-9130354851', 'unknown']) assert.equal((await call(server, 'GET', '/zoho/latest/' + id)).status, 404, id);
  } finally { server.close(); }
  const admin = await startApp({ staffId: 1, staffRole: 'admin', csrfToken: 'tok' });
  try {
    const list = await call(admin, 'GET', '/zoho/organisations');
    assert.deepEqual(list.json.organisations.map(o => [o.orgId, o.booksHost, o.lastReadAt]),
      [['60012345678', 'books.zoho.eu', '2026-11-19T10:00:00.000Z'], ['70012345678', 'books.zoho.com', null]]);
  } finally { admin.close(); }
});

test('zohoOrgIdOf only accepts a non-Xero client with a "zoho-<digits>" identifier', () => {
  assert.equal(zohoOrgIdOf(ORGS[1]), '60012345678');
  for (const org of [null, ORGS[0], ORGS[3], ORGS[4], { xero_tenant_id: 't', freeagent_company_id: 'zoho-60012345678' },
    { freeagent_company_id: 'zoho-6001x' }]) assert.equal(zohoOrgIdOf(org), null);
});

// ---- Xero is unchanged ----
const xeroAccount = { accountName: 'Main', accountNumber: '00', itemsToReconcile: 3, reconciled: false, balancesDiffer: false,
  balanceInXero: 10.005, statementBalance: -4, statementDateLabel: 'Oct 12', feedProblem: false, stoppedImporting: false, noFeed: false };

test('Xero readings: same endpoint, same validation, same saved payload, with the Zoho routes mounted in front', async () => {
  const xeroSaved = [], zohoSaved = [];
  const server = await startApp(staff, { xeroSaved, zohoSaved });
  try {
    const body = { shortCode: '!alpha', pageTitle: 'T', accounts: [xeroAccount], tenantId: 'tenant-1' };
    const ok = await call(server, 'POST', '/readings', { body, csrf: 'tok' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true, batchId: 41, name: 'Alpha Test Ltd', accounts: 1, checksUpdated: false });
    assert.deepEqual(xeroSaved[0].reading, validateReading(body));
    assert.deepEqual(xeroSaved[0].reading, { shortCode: '!alpha', pageTitle: 'T', accounts: [{ ...xeroAccount, balanceInXero: 10.01 }] });
    // A Zoho reading sent to the Xero endpoint is refused there, and a Xero one sent to the Zoho endpoint likewise.
    assert.equal((await call(server, 'POST', '/readings', { body: zohoBody(), csrf: 'tok' })).status, 400);
    assert.equal((await call(server, 'POST', '/zoho/readings', { body, csrf: 'tok' })).status, 400);
    // The Xero client list is unchanged: Zoho clients have no Xero short code and are never in it.
    const list = await call(server, 'GET', '/organisations');
    assert.deepEqual(list.json.organisations, [{ tenantId: 'tenant-1', name: 'Alpha Test Ltd', shortCode: '!alpha', lastReadAt: null }]);
    assert.equal(xeroSaved.length, 1);
    assert.equal(zohoSaved.length, 0);
  } finally { server.close(); }
});

// The service worker, loaded with a fake Chrome: the Xero requests are answered exactly as before and the Zoho one
// is routed to the Zoho reader. Only the checks that run before any tab is opened are exercised.
function loadServiceWorker({ zohoAllowed = true } = {}) {
  const listeners = [];
  const opened = [];
  const event = () => ({ addListener: () => {}, removeListener: () => {} });
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  const chrome = {
    runtime: { id: 'ext', onStartup: event(), onInstalled: event(), onMessage: { addListener: fn => listeners.push(fn) }, getManifest: () => manifest, getURL: file => 'chrome-extension://ext/' + file },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    permissions: { contains: async ({ origins }) => zohoAllowed && origins.length > 0 },
    tabs: {
      create: async ({ url }) => {
        if (!zohoAllowed && url === 'chrome-extension://ext/zoho-access.html') { opened.push(url); return { id: 9 }; }
        throw new Error('no tab should be opened');
      },
      remove: async () => {}, get: async () => ({}), sendMessage: async () => {}, onUpdated: event(), onRemoved: event(),
    },
    scripting: { executeScript: async () => [] },
  };
  const context = { chrome, console, setTimeout, clearTimeout, URL, Promise };
  context.self = context;
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), context));
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  const send = (message, url = 'https://wf.morethanaccountants.co.uk/akrio-verify/client/x') => new Promise(resolve => {
    const handled = listeners[0](message, { id: 'ext', url }, resolve);
    if (!handled) resolve('ignored');
  });
  return { send, opened };
}

test('the service worker answers Xero requests as before and routes Zoho requests to the Zoho reader', async () => {
  const { send } = loadServiceWorker();
  assert.deepEqual({ ...(await send({ type: 'READ_BANK_PAGE', shortCode: 'bad' })) },
    { ok: false, error: 'bad_short_code', message: 'This client has no valid Xero short code.' });
  assert.deepEqual({ ...(await send({ type: 'READ_BANK_LINES', shortCode: '!alpha', accountName: '' })) },
    { ok: false, error: 'bad_account', message: 'No bank account was named.' });
  assert.deepEqual({ ...(await send({ type: 'READ_ZOHO_BANKING', orgId: '../60012345678', booksHost: 'books.zoho.com' })) },
    { ok: false, error: 'bad_org_id', message: 'This client has no valid Zoho Books organisation id.' });
  // Only Akrio Verify's own pages may ask.
  assert.equal(await send({ type: 'READ_ZOHO_BANKING', orgId: '60012345678' }, 'https://books.zoho.com/app/1'), 'ignored');
  assert.equal(await send({ type: 'SOMETHING_ELSE' }), 'ignored');
});

test('a Zoho read without the Zoho permission opens the allow page and reads nothing', async () => {
  const { send, opened } = loadServiceWorker({ zohoAllowed: false });
  const answer = await send({ type: 'READ_ZOHO_BANKING', orgId: '60012345678', booksHost: 'books.zoho.com' });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'zoho_access_needed');
  assert.deepEqual(opened, ['chrome-extension://ext/zoho-access.html']);
  // Xero requests do not depend on the Zoho permission.
  assert.deepEqual({ ...(await send({ type: 'READ_BANK_PAGE', shortCode: 'bad' })) },
    { ok: false, error: 'bad_short_code', message: 'This client has no valid Xero short code.' });
});

test('the manifest keeps exactly the Xero sites as required and asks for the Zoho sites only as optional', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.5.1');
  assert.deepEqual(manifest.permissions, ['scripting', 'storage']);
  // Required sites unchanged from 1.4.3: a new required site makes Chrome disable the extension on update until
  // each user approves it, which would stop the Xero reads.
  assert.deepEqual(manifest.host_permissions, ['https://go.xero.com/*', 'https://login.xero.com/*']);
  for (const host of manifest.optional_host_permissions) {
    assert.match(host, /^https:\/\/(books|accounts)\.(zoho\.(com|eu|in|com\.au|jp|sa|uk|ae|com\.cn)|zohocloud\.ca)\/\*$/, host);
  }
  for (const host of zoho.BOOKS_HOSTS) {
    assert.ok(manifest.optional_host_permissions.includes('https://' + host + '/*'), host);
    assert.ok(manifest.optional_host_permissions.includes('https://' + host.replace(/^books\./, 'accounts.') + '/*'), host);
  }
  // The extension never runs on Zoho pages by itself: its only content script is on Verify's own pages.
  assert.deepEqual(manifest.content_scripts.map(script => script.matches), [['https://wf.morethanaccountants.co.uk/akrio-verify/*']]);
  assert.ok(manifest.description.length <= 132);
});
