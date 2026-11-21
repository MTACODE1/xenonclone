const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { parseAmount, parseWidget, shortCodeFromPath, isShortCode, bankAccountsUrl } = require('../extension/parser');
const { validateReading, buildShortCodeIndex, readingFreshness, ReadingError } = require('../src/services/bankScreenReading');
const { saveReading, getLatestReading, getLastReadTimes } = require('../src/db/bankScreenReadings');
const { createBankScreenRouter } = require('../src/routes/bankScreen');

// Widget text as Xero's page gives it (names and figures made up).
const FEED_STOPPED = ['Main Current Account', '00-00-00-00000000', 'There is a problem with this bank feed', 'Details...',
  'Reconcile 48 items', 'Balance in Xero', 'Balance in Xero\t(1,234.56)', 'Statement balance (Oct 12)',
  'Statement balance (Oct 12)\t(9,876.54)', 'This account has stopped importing transactions',
  'To continue automatically importing transactions you need to renew the connection.', 'Renew bank connection'].join('\n');
const DIFFERENT = ['Card Account', 'XXXX-XXXX-XXXX-0000', 'Why is this different?', 'Balance in Xero', 'Balance in Xero\t0.00',
  'Statement balance (Apr 30)', 'Statement balance (Apr 30)\t(2,000.00)', 'Skip graph', 'Oct 25', 'Nov 1',
  'Automatic bank feeds are available', 'Get bank feeds'].join('\n');
const RECONCILED = ['Savings', '00-00-00-11111111', 'Reconciled', 'Statement balance (Jul 5)', 'Statement balance (Jul 5)\t2.94'].join('\n');
const FOREIGN = ['USD Wallet', 'USD', 'Reconcile 1,205 items', 'Balance in Xero', 'Balance in Xero\t12,636.34',
  'Statement balance (Nov 18)', 'Statement balance (Nov 18)\t-396.46'].join('\n');

test('parseAmount reads brackets and minus as negative and never turns junk into 0', () => {
  assert.equal(parseAmount('(1,234.56)'), -1234.56);
  assert.equal(parseAmount('-396.46'), -396.46);
  assert.equal(parseAmount('12,636.34'), 12636.34);
  assert.equal(parseAmount('0.00'), 0);
  assert.ok(Object.is(parseAmount('(0.00)'), 0));
  for (const junk of [null, undefined, '', 'n/a', '1.2.3', 'Reconciled', '£5']) assert.equal(parseAmount(junk), null);
});

test('parseWidget: stopped feed with items to reconcile', () => {
  assert.deepEqual(parseWidget({ headerText: 'Main Current Account', text: FEED_STOPPED, feedProblem: true, noFeed: false }), {
    accountName: 'Main Current Account', accountNumber: '00-00-00-00000000', itemsToReconcile: 48, reconciled: false,
    balancesDiffer: false, balanceInXero: -1234.56, statementBalance: -9876.54, statementDateLabel: 'Oct 12',
    feedProblem: true, stoppedImporting: true, noFeed: false,
  });
});

test('parseWidget: nothing to reconcile but balances differ, no feed', () => {
  const parsed = parseWidget({ headerText: 'Card Account', text: DIFFERENT, feedProblem: false, noFeed: true });
  assert.equal(parsed.itemsToReconcile, null);
  assert.equal(parsed.reconciled, false);
  assert.equal(parsed.balancesDiffer, true);
  assert.equal(parsed.balanceInXero, 0);
  assert.equal(parsed.statementBalance, -2000);
  assert.equal(parsed.statementDateLabel, 'Apr 30');
  assert.equal(parsed.noFeed, true);
  assert.equal(parsed.stoppedImporting, false);
});

test('parseWidget: reconciled account without a Xero balance keeps the balance as null', () => {
  const parsed = parseWidget({ headerText: 'Savings', text: RECONCILED });
  assert.equal(parsed.reconciled, true);
  assert.equal(parsed.itemsToReconcile, null);
  assert.equal(parsed.balanceInXero, null);
  assert.equal(parsed.statementBalance, 2.94);
});

test('parseWidget: thousands separator in the count, currency label as the number line', () => {
  const parsed = parseWidget({ headerText: 'USD Wallet', text: FOREIGN });
  assert.equal(parsed.itemsToReconcile, 1205);
  assert.equal(parsed.accountNumber, 'USD');
  assert.equal(parsed.balanceInXero, 12636.34);
  assert.equal(parsed.statementBalance, -396.46);
});

test('parseWidget: an account called "Reconciled Holdings" is not treated as reconciled, and empty input is safe', () => {
  const parsed = parseWidget({ headerText: 'Reconciled Holdings', text: 'Reconciled Holdings\n123\nReconcile 1 item\nBalance in Xero\nBalance in Xero\t1.00' });
  assert.equal(parsed.reconciled, false);
  assert.equal(parsed.itemsToReconcile, 1);
  const empty = parseWidget(undefined);
  assert.equal(empty.accountName, '');
  assert.equal(empty.itemsToReconcile, null);
  assert.equal(empty.statementBalance, null);
});

test('parseWidget: "Get bank feeds" in the text means no feed even when the page marker is missing', () => {
  const text = ['Second Account', '00-00-00', 'Why is this different?', 'Balance in Xero', 'Balance in Xero\t(332.02)',
    'Statement balance (Sep 10)', 'Statement balance (Sep 10)\t39.20', 'Get bank feeds'].join('\n');
  assert.equal(parseWidget({ headerText: 'Second Account', text, noFeed: false }).noFeed, true);
  assert.equal(parseWidget({ headerText: 'Get bank feeds Ltd', text: 'Get bank feeds Ltd\n00\nReconciled' }).noFeed, false);
});

test('short codes and page paths', () => {
  assert.equal(shortCodeFromPath('/app/!AbC12/manage-bank-accounts'), '!AbC12');
  assert.equal(shortCodeFromPath('/app/%21AbC12/manage-bank-accounts/'), '!AbC12');
  assert.equal(shortCodeFromPath('/app/!AbC12/bills'), null);
  assert.equal(shortCodeFromPath('/identity/login'), null);
  assert.ok(isShortCode('!A-b!9'));
  for (const bad of ['AbC12', '!', '!a/b', '!abc?x=1', '!' + 'a'.repeat(13), 5, null]) assert.equal(isShortCode(bad), false);
  assert.equal(bankAccountsUrl('!AbC12'), 'https://go.xero.com/app/!AbC12/manage-bank-accounts');
});

const account = extra => ({
  accountName: 'Main', accountNumber: '00', itemsToReconcile: 3, reconciled: false, balancesDiffer: false,
  balanceInXero: 10.005, statementBalance: -4, statementDateLabel: 'Oct 12', feedProblem: false,
  stoppedImporting: false, noFeed: false, ...extra,
});

test('validateReading keeps only known fields, rounds money, keeps null as null', () => {
  const clean = validateReading({ shortCode: '!AbC12', pageTitle: ' Bank accounts ', extra: 'x', tenantId: 't',
    accounts: [account({ evil: '<script>' }), account({ itemsToReconcile: null, balanceInXero: null, statementDateLabel: null, accountNumber: '' })] });
  assert.deepEqual(Object.keys(clean), ['shortCode', 'pageTitle', 'accounts']);
  assert.equal(clean.pageTitle, 'Bank accounts');
  assert.equal(clean.accounts[0].balanceInXero, 10.01);
  assert.equal('evil' in clean.accounts[0], false);
  assert.equal(clean.accounts[1].itemsToReconcile, null);
  assert.equal(clean.accounts[1].balanceInXero, null);
  assert.equal(clean.accounts[1].accountNumber, null);
  assert.deepEqual(validateReading({ shortCode: '!AbC12', accounts: [] }).accounts, []);
});

test('validateReading rejects malformed readings', () => {
  const bad = [
    null, [], 'x', {}, { shortCode: 'AbC12', accounts: [] }, { shortCode: '!AbC12' }, { shortCode: '!AbC12', accounts: {} },
    { shortCode: '!AbC12', accounts: Array.from({ length: 61 }, () => account()) },
    { shortCode: '!AbC12', accounts: [null] },
    { shortCode: '!AbC12', accounts: [account({ accountName: '' })] },
    { shortCode: '!AbC12', accounts: [account({ accountName: 'x'.repeat(256) })] },
    { shortCode: '!AbC12', accounts: [account({ itemsToReconcile: -1 })] },
    { shortCode: '!AbC12', accounts: [account({ itemsToReconcile: 1.5 })] },
    { shortCode: '!AbC12', accounts: [account({ itemsToReconcile: '3' })] },
    { shortCode: '!AbC12', accounts: [account({ balanceInXero: '10' })] },
    { shortCode: '!AbC12', accounts: [account({ balanceInXero: Infinity })] },
    { shortCode: '!AbC12', accounts: [account({ statementBalance: 1e13 })] },
    { shortCode: '!AbC12', accounts: [account({ statementDateLabel: '<b>Oct</b>' })] },
    { shortCode: '!AbC12', accounts: [account({ reconciled: 'yes' })] },
    { shortCode: '!AbC12', accounts: [account({ noFeed: undefined })] },
  ];
  for (const body of bad) assert.throws(() => validateReading(body), ReadingError, JSON.stringify(body)?.slice(0, 80));
});

test('buildShortCodeIndex drops any code or organisation that is not one-to-one', () => {
  const { byCode, byOrg } = buildShortCodeIndex([
    { orgId: 1, shortCode: '!one11' }, { orgId: 1, shortCode: '!one11' },
    { orgId: 2, shortCode: '!dup22' }, { orgId: 3, shortCode: '!dup22' },
    { orgId: 4, shortCode: '!four4' }, { orgId: 4, shortCode: '!four5' },
    { orgId: 5, shortCode: 'bad' }, { orgId: '6', shortCode: '!six66' }, null,
  ]);
  assert.deepEqual([...byCode], [['!one11', 1]]);
  assert.deepEqual([...byOrg], [[1, '!one11']]);
});

test('readingFreshness marks readings older than seven days as stale', () => {
  const now = new Date('2026-11-19T12:00:00Z');
  assert.equal(readingFreshness('2026-11-13T12:00:00Z', now), 'current');
  assert.equal(readingFreshness(new Date('2026-11-12T11:59:00Z'), now), 'stale');
  assert.equal(readingFreshness('not a date', now), 'unknown');
});

function fakePool({ failOn = null } = {}) {
  const log = [];
  const connection = {
    beginTransaction: async () => log.push('begin'),
    query: async (sql, params) => {
      if (failOn && sql.includes(failOn)) throw new Error('insert failed');
      log.push([sql.replace(/\s+/g, ' ').trim().slice(0, 45), params]);
      return [{ insertId: 77 }];
    },
    commit: async () => log.push('commit'), rollback: async () => log.push('rollback'), release: () => log.push('release'),
  };
  return { log, getConnection: async () => connection };
}

test('saveReading writes the batch and its accounts in one transaction', async () => {
  const pool = fakePool();
  const reading = validateReading({ shortCode: '!AbC12', pageTitle: 'T', accounts: [account(), account({ accountName: 'Second', stoppedImporting: true })] });
  const id = await saveReading(5, reading, { id: 9, name: 'Tester' }, { pool, ensure: async () => {} });
  assert.equal(id, 77);
  assert.equal(pool.log[0], 'begin');
  assert.deepEqual(pool.log[1][1], [5, '!AbC12', 'T', 2, 9, 'Tester']);
  const rows = pool.log[2][1][0];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].slice(0, 5), [77, 5, 1, 'Second', '00']);
  assert.equal(rows[1][12], 1);
  assert.deepEqual(pool.log.slice(3), ['commit', 'release']);
});

test('saveReading rolls back when the account rows fail, and refuses a missing organisation', async () => {
  const pool = fakePool({ failOn: 'akrio_bank_screen_accounts' });
  const reading = validateReading({ shortCode: '!AbC12', accounts: [account()] });
  await assert.rejects(saveReading(5, reading, {}, { pool, ensure: async () => {} }), /insert failed/);
  assert.deepEqual(pool.log.slice(-2), ['rollback', 'release']);
  assert.equal(pool.log.includes('commit'), false);
  await assert.rejects(saveReading(undefined, reading, {}, { pool, ensure: async () => {} }), /organisation id/);
});

test('getLatestReading returns only the newest batch for that organisation', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push(params);
    if (sql.includes('akrio_bank_screen_batches')) return [[{ id: 3, page_title: 'T', read_by_name: 'A', read_at_unix: '1795082400' }]];
    return [[{ account_name: 'Main', account_number: null, items_to_reconcile: 4, reconciled: 0, balances_differ: 1,
      balance_in_xero: '-10.50', statement_balance: null, statement_date_label: 'Oct 12', feed_problem: 1, stopped_importing: 0, no_feed: 0 }]];
  } };
  const latest = await getLatestReading(5, { pool, ensure: async () => {} });
  assert.deepEqual(calls, [[5], [3, 5]]);
  assert.equal(latest.readAt.toISOString(), '2026-11-19T10:00:00.000Z');
  assert.equal(latest.accounts[0].balanceInXero, -10.5);
  assert.equal(latest.accounts[0].statementBalance, null);
  assert.equal(latest.accounts[0].balancesDiffer, true);
  const none = await getLatestReading(6, { pool: { query: async () => [[]] }, ensure: async () => {} });
  assert.equal(none, null);
});

test('getLastReadTimes maps each organisation to its newest read', async () => {
  const pool = { query: async () => [[{ org_id: 5, read_at_unix: '1795082400' }, { org_id: '6', read_at_unix: 1795082460 }]] };
  const times = await getLastReadTimes({ pool, ensure: async () => {} });
  assert.equal(times.get(5).toISOString(), '2026-11-19T10:00:00.000Z');
  assert.equal(times.get(6).toISOString(), '2026-11-19T10:01:00.000Z');
  assert.equal(times.get(7), undefined);
});

// ---- routes, with fake data access and a fake session ----
const ORGS = [
  { id: 1, name: 'Alpha Test Ltd', xero_tenant_id: 'tenant-1', period_key: 'since_lock_date:2025-10-31:2026-11-30' },
  { id: 2, name: 'Beta Test Ltd', xero_tenant_id: 'tenant-2' },
  { id: 3, name: 'No Code Ltd', xero_tenant_id: 'tenant-3' },
];
function startApp(session, saved = [], extraDeps = {}) {
  const app = express();
  app.use((req, res, next) => { req.session = session; next(); });
  app.use('/api/bank-screen', createBankScreenRouter({
    getAllOrganisations: async () => ORGS,
    getOrganisationById: async id => ORGS.find(o => o.id === id) || null,
    getOrganisationByTenantId: async tenantId => ORGS.find(o => o.xero_tenant_id === tenantId) || null,
    staffHasOrgAccess: async (staffId, orgId) => staffId === 9 && orgId === 1,
    getShortCodeIndex: async () => buildShortCodeIndex([{ orgId: 1, shortCode: '!alpha' }, { orgId: 2, shortCode: '!beta2' }]),
    saveReading: async (orgId, reading, staff) => { saved.push({ orgId, reading, staff }); return 41; },
    getLastReadTimes: async () => new Map([[1, new Date('2026-11-19T10:00:00Z')]]),
    getActiveBankAccountCount: async orgId => (orgId === 1 ? 4 : 0),
    getLatestReading: async orgId => (orgId === 1 ? { batchId: 41, readAt: new Date(), readByName: 'T', accounts: [] } : null),
    ...extraDeps,
  }));
  return new Promise(resolve => { const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server)); });
}
async function call(server, method, path, { body, csrf } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrf) headers['x-csrf-token'] = csrf;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bank-screen${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}
const staff = { staffId: 9, staffName: 'Tester', staffRole: 'staff', csrfToken: 'tok' };
const good = extra => ({ shortCode: '!alpha', pageTitle: 'T', accounts: [account()], ...extra });

test('POST /readings saves for the organisation the short code belongs to', async () => {
  const saved = [];
  const server = await startApp(staff, saved);
  try {
    const ok = await call(server, 'POST', '/readings', { body: good({ tenantId: 'tenant-1' }), csrf: 'tok' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true, batchId: 41, name: 'Alpha Test Ltd', accounts: 1, checksUpdated: false });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].orgId, 1);
    assert.deepEqual(saved[0].staff, { id: 9, name: 'Tester' });
  } finally { server.close(); }
});

test('POST /readings refuses: no token, wrong token, bad body, unknown code, no access, wrong client', async () => {
  const saved = [];
  const server = await startApp(staff, saved);
  try {
    assert.equal((await call(server, 'POST', '/readings', { body: good() })).status, 403);
    assert.equal((await call(server, 'POST', '/readings', { body: good(), csrf: 'nope' })).status, 403);
    assert.equal((await call(server, 'POST', '/readings', { body: good({ accounts: 'x' }), csrf: 'tok' })).status, 400);
    assert.equal((await call(server, 'POST', '/readings', { body: good({ shortCode: '!nomatch' }), csrf: 'tok' })).status, 404);
    // Staff member 9 has no access to organisation 2.
    assert.equal((await call(server, 'POST', '/readings', { body: good({ shortCode: '!beta2' }), csrf: 'tok' })).status, 403);
    // The page was on client 2 but Xero's code belongs to client 1.
    assert.equal((await call(server, 'POST', '/readings', { body: good({ tenantId: 'tenant-2' }), csrf: 'tok' })).status, 409);
    assert.equal(saved.length, 0);
  } finally { server.close(); }
});

test('POST /readings refuses an empty reading when Xero has bank accounts for the client', async () => {
  const saved = [];
  const server = await startApp(staff, saved);
  try {
    const empty = await call(server, 'POST', '/readings', { body: good({ accounts: [] }), csrf: 'tok' });
    assert.equal(empty.status, 409);
    assert.match(empty.json.error, /has 4 in Xero/);
    assert.equal(saved.length, 0);
  } finally { server.close(); }
  const adminSaved = [];
  const adminServer = await startApp({ staffId: 1, staffRole: 'admin', csrfToken: 'tok' }, adminSaved);
  try {
    // A client with no bank accounts in Xero can still record "none".
    const none = await call(adminServer, 'POST', '/readings', { body: good({ shortCode: '!beta2', accounts: [] }), csrf: 'tok' });
    assert.equal(none.status, 200);
    assert.equal(adminSaved.length, 1);
  } finally { adminServer.close(); }
});

test('a session without a form token cannot post even with an empty header', async () => {
  const server = await startApp({ staffId: 9, staffRole: 'staff' });
  try {
    assert.equal((await call(server, 'POST', '/readings', { body: good() })).status, 403);
  } finally { server.close(); }
});

test('GET /organisations and /latest only cover clients the staff member can access', async () => {
  const server = await startApp(staff);
  try {
    const list = await call(server, 'GET', '/organisations');
    assert.deepEqual(list.json.organisations, [{ tenantId: 'tenant-1', name: 'Alpha Test Ltd', shortCode: '!alpha', lastReadAt: '2026-11-19T10:00:00.000Z' }]);
    const mine = await call(server, 'GET', '/latest/tenant-1');
    assert.equal(mine.status, 200);
    assert.equal(mine.json.shortCode, '!alpha');
    assert.equal(mine.json.reading.freshness, 'current');
    assert.equal((await call(server, 'GET', '/latest/tenant-2')).status, 403);
    assert.equal((await call(server, 'GET', '/latest/unknown')).status, 404);
  } finally { server.close(); }
  const adminServer = await startApp({ staffId: 1, staffRole: 'admin', csrfToken: 'tok' });
  try {
    const list = await call(adminServer, 'GET', '/organisations');
    assert.deepEqual(list.json.organisations.map(o => o.shortCode), ['!alpha', '!beta2']);
    assert.equal(list.json.organisations[1].lastReadAt, null);
    assert.equal((await call(adminServer, 'GET', '/latest/tenant-2')).json.reading, null);
  } finally { adminServer.close(); }
});

// ---- the bank checks are recalculated from a newly saved reading ----
test('POST /readings recalculates the bank checks once, after the reading is saved', async () => {
  const events = [];
  const saved = { push: entry => events.push(['save', entry.orgId]) };
  const server = await startApp(staff, saved, { recomputeEvidenceIssues: async (orgId, periodKey) => { events.push(['recompute', orgId, periodKey]); } });
  try {
    const ok = await call(server, 'POST', '/readings', { body: good({ tenantId: 'tenant-1' }), csrf: 'tok' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.checksUpdated, true);
    assert.deepEqual(events, [['save', 1], ['recompute', 1, 'since_lock_date:2025-10-31:2026-11-30']]);
  } finally { server.close(); }
});

test('POST /readings still reports the saved reading when the recalculation fails', async () => {
  const saved = [];
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const server = await startApp(staff, saved, { recomputeEvidenceIssues: async () => { throw new Error('sqlite busy'); } });
  try {
    const ok = await call(server, 'POST', '/readings', { body: good({ tenantId: 'tenant-1' }), csrf: 'tok' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.checksUpdated, false);
    assert.equal(saved.length, 1);
    assert.ok(errors.some(line => /could not be recalculated/.test(line) && /sqlite busy/.test(line)));
  } finally { server.close(); console.error = original; }
});

test('POST /readings never recalculates when nothing was saved', async () => {
  const recomputed = [];
  const server = await startApp(staff, [], { recomputeEvidenceIssues: async orgId => { recomputed.push(orgId); } });
  try {
    assert.equal((await call(server, 'POST', '/readings', { body: good(), csrf: 'nope' })).status, 403);
    assert.equal((await call(server, 'POST', '/readings', { body: good({ shortCode: '!beta2' }), csrf: 'tok' })).status, 403);
    assert.equal((await call(server, 'POST', '/readings', { body: good({ tenantId: 'tenant-2' }), csrf: 'tok' })).status, 409);
    assert.equal((await call(server, 'POST', '/readings', { body: good({ accounts: [] }), csrf: 'tok' })).status, 409);
    assert.deepEqual(recomputed, []);
  } finally { server.close(); }
  const failingSave = await startApp(staff, { push: () => { throw new Error('mysql down'); } }, { recomputeEvidenceIssues: async orgId => { recomputed.push(orgId); } });
  try {
    const original = console.error; console.error = () => {};
    const failed = await call(failingSave, 'POST', '/readings', { body: good(), csrf: 'tok' });
    console.error = original;
    assert.equal(failed.status, 500);
    assert.deepEqual(recomputed, []);
  } finally { failingSave.close(); }
});

// ---- unreconciled statement lines (the "items to reconcile" list) ----
const linesParser = require('../extension/parser.js');
const COLUMNS = ['', 'Date', 'Type', 'Payee', 'Particulars', 'Code', 'Reference', 'Analysis Code', 'Spent', 'Received', 'Balance', 'Source', 'Status'];

test('statement rows become lines: only Unreconciled rows with a date, amounts by column heading', () => {
  const lines = linesParser.parseStatementRows(COLUMNS, [
    ['', '12 Oct 2026', 'Debit', '', 'CARD PAYMENT SHOP', '', 'REF 1', '', '10.99', '', '(13,319.39)', 'Bank Feed', 'Unreconciled'],
    ['', '15 Jun 2026', 'Credit', 'A Payer', 'TRANSFER IN', 'C1', '', '', '', '1,150.00', '', 'Bank Feed', 'Unreconciled'],
    ['', '9 Oct 2026', 'Debit', '', 'ALREADY DONE', '', '', '', '5.00', '', '', 'Bank Feed', 'Reconciled'],
    ['There are no statement lines to display'],
    ['', 'not a date', 'Debit', '', 'X', '', '', '', '1.00', '', '', 'Bank Feed', 'Unreconciled'],
  ]);
  assert.deepEqual(lines, [
    { date: '2026-10-12', type: 'Debit', payee: null, particulars: 'CARD PAYMENT SHOP', code: null, reference: 'REF 1', spent: 10.99, received: null, source: 'Bank Feed' },
    { date: '2026-06-15', type: 'Credit', payee: 'A Payer', particulars: 'TRANSFER IN', code: 'C1', reference: null, spent: null, received: 1150, source: 'Bank Feed' },
  ]);
  // A moved column is still read by its heading.
  const moved = linesParser.parseStatementRows(['Status', 'Received', 'Spent', 'Date'], [['Unreconciled', '', '7.50', '1 Jan 2026']]);
  assert.equal(moved[0].spent, 7.5);
  assert.equal(moved[0].date, '2026-01-01');
  // A table without the columns we need is refused, not guessed at.
  assert.equal(linesParser.parseStatementRows(['Date', 'Amount', 'Status'], [['1 Jan 2026', '5', 'Unreconciled']]), null);
});

test('Xero dates, account ids and the statement page address', () => {
  assert.equal(linesParser.parseXeroDate('1 Feb 2026'), '2026-02-01');
  assert.equal(linesParser.parseXeroDate('Feb 1'), null); // no year: never guessed
  assert.equal(linesParser.parseXeroDate('32 Feb 2026'), null);
  const id = 'dad3cde729bb42d1990cde6ee3f88d74';
  assert.equal(linesParser.accountIdFromHref('/Bank/BankTransactions.aspx?accountId=DAD3CDE729BB42D1990CDE6EE3F88D74'), id);
  assert.equal(linesParser.accountIdFromHref('/BankRec/BankRec.aspx?accountID=dad3cde7-29bb-42d1-990c-de6ee3f88d74&x=1'), id);
  assert.equal(linesParser.accountIdFromHref('/Bank/BankTransactions.aspx?accountId=javascript:alert(1)'), null);
  assert.equal(linesParser.accountIdFromHref('https://evil.example/?other=1'), null);
  assert.equal(linesParser.isAccountId(id), true);
  assert.equal(linesParser.isAccountId(id + '0'), false);
  const url = new URL(linesParser.statementsUrl('!AbC12', id));
  assert.equal(url.origin, 'https://go.xero.com');
  assert.equal(url.pathname, '/organisationlogin/default.aspx');
  assert.equal(url.searchParams.get('shortcode'), '!AbC12');
  assert.equal(url.searchParams.get('redirecturl'), '/Bank/Statements.aspx?accountID=' + id);
  assert.equal(linesParser.sameName('  Main   Account ', 'main account'), true);
  assert.equal(linesParser.sameName('PayPal', 'PayPal 1'), false);
});

// ---- saving the "items to reconcile" list ----
const { validateLines, summariseLines } = require('../src/services/bankScreenReading');
const goodLine = extra => ({ date: '2026-10-12', type: 'Debit', payee: null, particulars: 'CARD PAYMENT', code: null, reference: 'R1', spent: 10.99, received: null, source: 'Bank Feed', ...extra });
const goodLines = extra => ({ shortCode: '!alpha', accountName: 'Main Account', lines: [goodLine(), goodLine({ date: '2026-06-15', spent: null, received: 150 })], truncated: false, totalShownByXero: 2, ...extra });

test('validateLines keeps known fields only and refuses anything malformed', () => {
  const clean = validateLines({ ...goodLines(), extra: 'x', lines: [{ ...goodLine(), hack: '<script>' }] });
  assert.deepEqual(Object.keys(clean).sort(), ['accountName', 'lines', 'shortCode', 'totalShownByXero', 'truncated']);
  assert.equal(clean.lines[0].hack, undefined);
  assert.equal(clean.lines[0].spent, 10.99);
  for (const bad of [
    goodLines({ shortCode: 'nope' }), goodLines({ accountName: '' }), goodLines({ lines: 'x' }),
    goodLines({ lines: [goodLine({ date: '12 Oct 2026' })] }), goodLines({ lines: [goodLine({ date: '2026-02-30' })] }),
    goodLines({ lines: [goodLine({ spent: '10.99' })] }), goodLines({ lines: [goodLine({ particulars: 'x'.repeat(501) })] }),
    goodLines({ lines: Array.from({ length: 1001 }, () => goodLine()) }), goodLines({ totalShownByXero: -1 }),
  ]) assert.throws(() => validateLines(bad), ReadingError);
  assert.deepEqual(summariseLines(clean.lines.concat([goodLine({ date: '2026-06-15', spent: null, received: 150 })])), { value: 160.99, oldest: '2026-06-15' });
  assert.deepEqual(summariseLines([]), { value: 0, oldest: null });
});

test('POST /lines saves for the right client and account, and refuses the rest', async () => {
  const savedLines = [];
  const recomputed = [];
  const deps = {
    getLatestReading: async orgId => (orgId === 1 ? { batchId: 41, readAt: new Date(), readByName: 'T', accounts: [{ accountName: 'Main Account', itemsToReconcile: 2 }] } : null),
    saveLines: async (orgId, read, staffMember) => { savedLines.push({ orgId, read, staffMember }); return 7; },
    getStoredLines: async (orgId, accountName) => ({ accountName, lines: [goodLine()], orgId }),
    recomputeEvidenceIssues: async (orgId, periodKey, onlyCheck) => { recomputed.push([orgId, periodKey, onlyCheck]); },
  };
  const server = await startApp(staff, [], deps);
  try {
    const ok = await call(server, 'POST', '/lines', { body: goodLines({ tenantId: 'tenant-1' }), csrf: 'tok' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true, readId: 7, lines: 2, checksUpdated: true });
    assert.equal(savedLines[0].orgId, 1);
    assert.deepEqual(savedLines[0].staffMember, { id: 9, name: 'Tester' });
    assert.deepEqual(recomputed, [[1, 'since_lock_date:2025-10-31:2026-11-30', 'unprocessed_bank']]);
    assert.equal((await call(server, 'POST', '/lines', { body: goodLines() })).status, 403);                         // no token
    assert.equal((await call(server, 'POST', '/lines', { body: goodLines({ lines: 'x' }), csrf: 'tok' })).status, 400);
    assert.equal((await call(server, 'POST', '/lines', { body: goodLines({ shortCode: '!nomatch' }), csrf: 'tok' })).status, 404);
    assert.equal((await call(server, 'POST', '/lines', { body: goodLines({ shortCode: '!beta2' }), csrf: 'tok' })).status, 403); // no access to client 2
    assert.equal((await call(server, 'POST', '/lines', { body: goodLines({ tenantId: 'tenant-2' }), csrf: 'tok' })).status, 409);
    assert.equal((await call(server, 'POST', '/lines', { body: goodLines({ accountName: 'Unknown Account' }), csrf: 'tok' })).status, 409);
    assert.equal(savedLines.length, 1);
    const stored = await call(server, 'GET', '/lines/tenant-1?account=Main%20Account');
    assert.equal(stored.status, 200);
    assert.equal(stored.json.stored.orgId, 1);
    assert.equal((await call(server, 'GET', '/lines/tenant-2?account=Main%20Account')).status, 403);
    assert.equal((await call(server, 'GET', '/lines/tenant-1')).status, 400);
  } finally { server.close(); }
});
