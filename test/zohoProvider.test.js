// Zoho Books provider: mapping to the Xero shapes, reading every page, the sign-in and the token
// refresh. A fake Zoho (fetch replaced) and a fake token table stand in; nothing here reaches Zoho
// or the database. All data is made up, shaped like the examples in Zoho's API docs.
const test = require('node:test');
const assert = require('node:assert/strict');

// In-memory akrio_ledger_tokens, stored the way MySQL hands rows back (dateStrings: UTC text).
const tokenRows = new Map();
const saves = [];
const toDbText = value => (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 19).replace('T', ' ');
const tokensPath = require.resolve('../src/db/ledgerTokens');
require.cache[tokensPath] = {
  id: tokensPath, filename: tokensPath, loaded: true,
  exports: {
    getLedgerToken: async (provider, externalId) => tokenRows.get(`${provider}:${externalId}`) || null,
    saveLedgerToken: async (provider, externalId, token) => {
      saves.push({ provider, externalId, token });
      const old = tokenRows.get(`${provider}:${externalId}`) || {};
      tokenRows.set(`${provider}:${externalId}`, {
        ...old, provider, external_id: String(externalId), access_token: token.access_token,
        refresh_token: token.refresh_token, expires_at: toDbText(token.expires_at),
        api_domain: token.api_domain || old.api_domain || null,
        accounts_server: token.accounts_server || old.accounts_server || null,
      });
    },
    deleteLedgerToken: async () => {},
  },
};

const client = require('../src/services/ledgers/zoho/client');
const zoho = require('../src/services/ledgers/zoho');

// Fake Zoho: handlers are matched in order; each request is recorded.
let requests = [];
let handlers = [];
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});
global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const body = options.body ? Object.fromEntries(new URLSearchParams(String(options.body))) : null;
  const request = { url, method: options.method || 'GET', headers: options.headers || {}, body };
  requests.push(request);
  for (const handler of handlers) {
    const answer = await handler(request);
    if (answer) return answer;
  }
  throw new Error(`Unexpected request in test: ${url}`);
};

const sleeps = [];
client.__setSleep(async ms => { sleeps.push(ms); });

const ORG = '600000001';
const future = () => toDbText(new Date(Date.now() + 50 * 60 * 1000));
const past = () => toDbText(new Date(Date.now() - 60 * 1000));
function storeToken(externalId, overrides = {}) {
  tokenRows.set(`zoho:${externalId}`, {
    provider: 'zoho', external_id: externalId, access_token: 'access-old', refresh_token: 'refresh-1',
    expires_at: future(), api_domain: 'https://www.zohoapis.eu', accounts_server: 'https://accounts.zoho.eu',
    ...overrides,
  });
}
const isBooks = (request, path) => request.url.pathname === `/books/v3${path}`;
const isToken = request => request.url.pathname === '/oauth/v2/token';

test.beforeEach(() => {
  requests = []; handlers = []; saves.length = 0; sleeps.length = 0; tokenRows.clear(); client.__reset();
  process.env.ZOHO_CLIENT_ID = 'test-client-id';
  process.env.ZOHO_CLIENT_SECRET = 'test-client-secret';
  process.env.ZOHO_REDIRECT_URI = 'https://verify.example.test/auth/zoho/callback';
  delete process.env.ZOHO_ACCOUNTS_URL;
});

test('isConfigured needs all three app settings', () => {
  assert.equal(zoho.isConfigured(), true);
  delete process.env.ZOHO_CLIENT_SECRET;
  assert.equal(zoho.isConfigured(), false);
});

test('consent URL asks for read-only scopes, offline access and the consent screen', () => {
  const url = new URL(zoho.buildConsentUrl('state-123'));
  assert.equal(url.origin + url.pathname, 'https://accounts.zoho.com/oauth/v2/auth');
  const scopes = url.searchParams.get('scope').split(',');
  assert.ok(scopes.length > 0);
  for (const scope of scopes) assert.match(scope, /^ZohoBooks\.[a-z]+\.READ$/, 'read-only scopes only');
  for (const needed of ['ZohoBooks.invoices.READ', 'ZohoBooks.bills.READ', 'ZohoBooks.creditnotes.READ',
    'ZohoBooks.debitnotes.READ', 'ZohoBooks.contacts.READ', 'ZohoBooks.settings.READ']) {
    assert.ok(scopes.includes(needed), `${needed} is asked for`);
  }
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.equal(url.searchParams.get('client_id'), 'test-client-id');
  process.env.ZOHO_ACCOUNTS_URL = 'https://accounts.zoho.eu/';
  assert.match(zoho.buildConsentUrl('s'), /^https:\/\/accounts\.zoho\.eu\/oauth\/v2\/auth\?/);
});

test('completeConnection swaps the code at the customer\'s data centre and lists every organisation', async () => {
  handlers.push(request => isToken(request) && json({
    access_token: 'access-new', refresh_token: 'refresh-new', api_domain: 'https://www.zohoapis.eu',
    token_type: 'Bearer', expires_in: 3600,
  }));
  handlers.push(request => isBooks(request, '/organizations') && json({
    code: 0, message: 'success',
    organizations: [
      { organization_id: '600000001', name: 'Example Trading Ltd', currency_code: 'GBP', fiscal_year_start_month: 3 },
      { organization_id: '600000002', name: 'Sample Services Ltd', currency_code: 'GBP', fiscal_year_start_month: 0 },
    ],
  }));
  const companies = await zoho.completeConnection({
    code: 'grant-code', state: 's', location: 'eu', 'accounts-server': 'https://accounts.zoho.eu',
  });

  const tokenCall = requests[0];
  assert.equal(tokenCall.url.origin, 'https://accounts.zoho.eu', 'the EU accounts server, not .com');
  assert.equal(tokenCall.method, 'POST');
  assert.equal(tokenCall.body.grant_type, 'authorization_code');
  assert.equal(tokenCall.body.code, 'grant-code');
  assert.equal(tokenCall.body.redirect_uri, process.env.ZOHO_REDIRECT_URI);
  assert.equal(requests[1].url.origin, 'https://www.zohoapis.eu', 'the API domain from the token answer');
  assert.equal(requests[1].headers.Authorization, 'Zoho-oauthtoken access-new');

  assert.deepEqual(companies.map(c => [c.externalId, c.name]), [
    ['600000001', 'Example Trading Ltd'], ['600000002', 'Sample Services Ltd'],
  ]);
  for (const company of companies) {
    assert.equal(company.token.access_token, 'access-new');
    assert.equal(company.token.refresh_token, 'refresh-new');
    assert.equal(company.token.api_domain, 'https://www.zohoapis.eu');
    assert.equal(company.token.accounts_server, 'https://accounts.zoho.eu');
    assert.equal(company.token.refresh_expires_at, null);
    assert.ok(new Date(company.token.expires_at).getTime() > Date.now() + 55 * 60 * 1000);
  }
  assert.equal(saves.length, 0, 'nothing is written: the route saves the chosen ones');
});

test('completeConnection never sends the client secret to a server that is not Zoho', async () => {
  await assert.rejects(
    zoho.completeConnection({ code: 'grant-code', 'accounts-server': 'https://accounts.zoho.eu.attacker.test' }),
    /not a Zoho address/
  );
  assert.equal(requests.length, 0);
});

test('completeConnection refuses an answer without a refresh token, and a Zoho error sent with HTTP 200', async () => {
  handlers.push(request => isToken(request) && json({ access_token: 'a', api_domain: 'https://www.zohoapis.com', expires_in: 3600 }));
  await assert.rejects(zoho.completeConnection({ code: 'c' }), /refresh token/);
  assert.equal(requests[0].url.origin, 'https://accounts.zoho.com', 'default accounts server when none is sent back');
  handlers = [request => isToken(request) && json({ error: 'invalid_code' })];
  await assert.rejects(zoho.completeConnection({ code: 'c' }), /invalid_code/);
});

function pagedList(listKey, rows, perPageSeen) {
  return request => {
    const page = Number(request.url.searchParams.get('page'));
    const perPage = Number(request.url.searchParams.get('per_page'));
    perPageSeen.push({ listKey, page, perPage, request });
    const slice = rows.slice((page - 1) * perPage, page * perPage);
    // The docs show page_context as a one-item array; real answers send an object. Both are read.
    const context = { page, per_page: perPage, has_more_page: page * perPage < rows.length, applied_filter: 'Status.All' };
    return json({ code: 0, message: 'success', [listKey]: slice, page_context: listKey === 'bills' ? [context] : context });
  };
}

function invoiceRow(i, extra = {}) {
  return {
    invoice_id: `46000000${String(i).padStart(5, '0')}`, invoice_number: `INV-${i}`, reference_number: `PO-${i}`,
    customer_id: '460000000001', customer_name: 'Example Customer Ltd', status: 'sent',
    date: '2026-09-01', due_date: '2026-10-01', currency_code: 'GBP', total: 120, balance: 120,
    has_attachment: false, exchange_rate: 1, ...extra,
  };
}

test('fetchDocuments reads every page of every list and maps them to the Xero shapes', async () => {
  storeToken(ORG);
  const seen = [];
  const invoices = Array.from({ length: 450 }, (_, i) => invoiceRow(i + 1));
  Object.assign(invoices[0], { status: 'draft' });
  Object.assign(invoices[1], { status: 'pending_approval' });
  Object.assign(invoices[2], { status: 'paid', balance: 0 });
  Object.assign(invoices[3], { status: 'void', balance: 120 });
  Object.assign(invoices[4], { status: 'partially_paid', balance: '20.50', total: '120.00' });
  Object.assign(invoices[5], { status: 'overdue' });
  const bills = [
    { bill_id: '460000000101', bill_number: 'B-1', reference_number: 'R-1', vendor_id: '460000000002', vendor_name: 'Example Supplier Ltd',
      status: 'open', date: '2026-08-01', due_date: '2026-08-31', currency_code: 'GBP', total: 60, balance: 60, has_attachment: true },
    { bill_id: '460000000102', bill_number: 'B-2', vendor_id: '460000000002', vendor_name: 'Example Supplier Ltd',
      status: 'draft', date: '2026-08-02', due_date: '2026-09-01', currency_code: 'GBP', total: 30, balance: 30, has_attachment: false },
    { bill_id: '460000000103', bill_number: 'B-3', vendor_id: '460000000002', vendor_name: 'Example Supplier Ltd',
      status: 'paid', date: '2026-08-03', due_date: '2026-09-02', currency_code: 'GBP', total: 40, balance: 0 },
  ];
  const creditnotes = [
    { creditnote_id: '460000000201', creditnote_number: 'CN-1', status: 'open', reference_number: '', date: '2026-07-01',
      total: -50, balance: 25, customer_id: '460000000001', customer_name: 'Example Customer Ltd', currency_code: 'GBP' },
    { creditnote_id: '460000000202', creditnote_number: 'CN-2', status: 'closed', date: '2026-07-02',
      total: 10, balance: 0, customer_id: '460000000001', customer_name: 'Example Customer Ltd', currency_code: 'GBP' },
    { creditnote_id: '460000000203', creditnote_number: 'CN-3', status: 'void', date: '2026-07-03',
      total: 10, balance: 10, customer_id: '460000000001', customer_name: 'Example Customer Ltd', currency_code: 'GBP' },
  ];
  const vendorcredits = [
    { vendor_credit_id: '460000000301', vendor_credit_number: 'DN-1', status: 'open', date: '2026-06-01',
      total: 75, balance: 75, vendor_id: '460000000002', vendor_name: 'Example Supplier Ltd', currency_code: 'GBP', has_attachment: false },
    { vendor_credit_id: '460000000302', vendor_credit_number: 'DN-2', status: 'draft', date: '2026-06-02',
      total: 5, balance: 5, vendor_id: '460000000002', vendor_name: 'Example Supplier Ltd', currency_code: 'GBP' },
  ];
  const contacts = [
    { contact_id: '460000000001', contact_name: 'Example Customer Ltd', company_name: 'Example Customer Ltd',
      contact_type: 'customer', status: 'active', email: 'accounts@customer.example' },
    { contact_id: '460000000002', contact_name: '', company_name: 'Example Supplier Ltd',
      contact_type: 'vendor', status: 'inactive', email: '' },
  ];
  handlers.push(r => isBooks(r, '/invoices') && pagedList('invoices', invoices, seen)(r));
  handlers.push(r => isBooks(r, '/bills') && pagedList('bills', bills, seen)(r));
  handlers.push(r => isBooks(r, '/creditnotes') && pagedList('creditnotes', creditnotes, seen)(r));
  handlers.push(r => isBooks(r, '/vendorcredits') && pagedList('vendor_credits', vendorcredits, seen)(r));
  handlers.push(r => isBooks(r, '/contacts') && pagedList('contacts', contacts, seen)(r));

  const messages = [];
  const docs = await zoho.fetchDocuments(ORG, { emit: m => messages.push(m) });

  // Paging: 450 invoices at 200 a page is three pages, and every call carries what Zoho needs.
  assert.deepEqual(seen.filter(s => s.listKey === 'invoices').map(s => s.page), [1, 2, 3]);
  for (const s of seen) {
    assert.equal(s.perPage, 200);
    assert.equal(s.request.url.searchParams.get('organization_id'), ORG);
    assert.equal(s.request.url.searchParams.get('filter_by'), 'Status.All');
    assert.equal(s.request.url.origin, 'https://www.zohoapis.eu');
    assert.equal(s.request.headers.Authorization, 'Zoho-oauthtoken access-old');
  }
  assert.equal(docs.invoices.length, 450);
  assert.ok(messages.length > 0);

  const [draft, pending, paid, voided, partial, overdue] = docs.invoices;
  assert.deepEqual([draft, pending, paid, voided, partial, overdue].map(i => i.status),
    ['DRAFT', 'SUBMITTED', 'PAID', 'VOIDED', 'AUTHORISED', 'AUTHORISED']);
  assert.equal(voided.amountDue, 0, 'a void invoice owes nothing');
  assert.equal(partial.total, 120);
  assert.equal(partial.amountDue, 20.5, 'amounts sent as text are read as numbers');
  assert.equal(partial.amountPaid, 99.5);
  assert.deepEqual(overdue.contact, { contactID: '460000000001', name: 'Example Customer Ltd' });
  assert.equal(overdue.type, 'ACCREC');
  assert.equal(overdue.invoiceNumber, 'INV-6');
  assert.equal(overdue.reference, 'PO-6');
  assert.equal(overdue.date, '2026-09-01');
  assert.equal(overdue.dueDate, '2026-10-01');
  assert.equal(overdue.currencyCode, 'GBP');
  assert.equal(overdue.subTotal, null, 'the list has no net figure');
  assert.deepEqual(overdue.lineItems, []);

  assert.deepEqual(docs.bills.map(b => [b.invoiceID, b.type, b.status, b.hasAttachments]), [
    ['bill-460000000101', 'ACCPAY', 'AUTHORISED', true],
    ['bill-460000000102', 'ACCPAY', 'DRAFT', false],
    ['bill-460000000103', 'ACCPAY', 'PAID', false],
  ]);
  assert.equal(docs.bills[0].contact.name, 'Example Supplier Ltd');
  const ids = new Set([...docs.invoices, ...docs.bills].map(d => d.invoiceID));
  assert.equal(ids.size, docs.invoices.length + docs.bills.length, 'invoice and bill ids never collide');

  assert.deepEqual(docs.credits.map(c => [c.creditNoteID, c.type, c.status, c.total, c.remainingCredit]), [
    ['460000000201', 'ACCRECCREDIT', 'AUTHORISED', 50, 25],
    ['460000000202', 'ACCRECCREDIT', 'PAID', 10, 0],
    ['460000000203', 'ACCRECCREDIT', 'VOIDED', 10, 0],
    ['vc-460000000301', 'ACCPAYCREDIT', 'AUTHORISED', 75, 75],
    ['vc-460000000302', 'ACCPAYCREDIT', 'DRAFT', 5, 5],
  ]);
  assert.equal(docs.credits[0].creditNoteNumber, 'CN-1');
  assert.equal(docs.credits[3].contact.name, 'Example Supplier Ltd');

  assert.deepEqual(docs.contacts.map(c => [c.contactID, c.name, c.contactStatus]), [
    ['460000000001', 'Example Customer Ltd', 'ACTIVE'],
    ['460000000002', 'Example Supplier Ltd', 'ARCHIVED'],
  ]);
  assert.equal(docs.contacts[0].emailAddress, 'accounts@customer.example');
});

test('a list that fails part-way throws instead of returning half the documents', async () => {
  storeToken(ORG);
  handlers.push(r => isBooks(r, '/contacts') && (Number(r.url.searchParams.get('page')) === 1
    ? json({ code: 0, message: 'success', contacts: [{ contact_id: '1', contact_name: 'A', status: 'active' }], page_context: { has_more_page: true } })
    : json({ code: 1, message: 'Internal error' }, 500)));
  await assert.rejects(zoho.fetchDocuments(ORG), /500/);
  assert.equal(sleeps.length, 5, 'retried with backoff before giving up');
});

test('a 429 waits as long as Retry-After asks, then carries on', async () => {
  storeToken(ORG);
  let first = true;
  handlers.push(r => {
    if (!isBooks(r, '/organizations/600000001')) return null;
    if (first) { first = false; return json({ code: 44, message: 'per-minute limit' }, 429, { 'Retry-After': '40' }); }
    return json({ code: 0, message: 'success', organization: { organization_id: ORG, name: 'Example Trading Ltd', fiscal_year_start_month: 3, currency_code: 'GBP' } });
  });
  handlers.push(r => isBooks(r, '/transactionlock') && json({ code: 0, message: 'success', transaction_lock: {
    transaction_lock_id: '1', transaction_lock_status: 'enabled', transaction_lock_date: '2026-03-31', lock_status: 'locked', lock_scope: 0,
  } }));
  const info = await zoho.fetchCompanyInfo(ORG);
  assert.equal(sleeps[0], 40000);
  assert.deepEqual(info, {
    name: 'Example Trading Ltd', lockDate: '2026-03-31', financialYearEndMonth: 3, financialYearEndDay: 31, baseCurrency: 'GBP',
  });
});

test('the daily call limit (code 45) is not retried', async () => {
  storeToken(ORG);
  handlers.push(r => isBooks(r, '/contacts') && json({ code: 45, message: 'daily limit exceeded' }, 429));
  await assert.rejects(zoho.fetchDocuments(ORG), /daily API limit/);
  assert.equal(sleeps.length, 0);
});

test('financial year end and lock date: January start, month names, no lock', async () => {
  assert.deepEqual(zoho.financialYearEnd(0), { financialYearEndMonth: 12, financialYearEndDay: 31 });
  assert.deepEqual(zoho.financialYearEnd(3), { financialYearEndMonth: 3, financialYearEndDay: 31 });
  assert.deepEqual(zoho.financialYearEnd('april'), { financialYearEndMonth: 3, financialYearEndDay: 31 });
  assert.deepEqual(zoho.financialYearEnd(undefined), {});
  assert.deepEqual(zoho.financialYearEnd(12), {});

  storeToken(ORG);
  handlers.push(r => isBooks(r, '/organizations/600000001') && json({ code: 0, message: 'success', organization: { name: 'X', fiscal_year_start_month: 0, currency_code: 'GBP' } }));
  handlers.push(r => isBooks(r, '/transactionlock') && json({ code: 0, message: 'success', transaction_lock: { transaction_lock_status: 'disabled', transaction_lock_date: '2025-12-31' } }));
  assert.equal((await zoho.fetchCompanyInfo(ORG)).lockDate, null, 'a lock that is off is no lock date');
  handlers.splice(1, 1, r => isBooks(r, '/transactionlock') && json({ code: 1002, message: 'Feature not available' }, 400));
  const info = await zoho.fetchCompanyInfo(ORG);
  assert.equal(info.lockDate, null, 'no locking on this plan: null, the sync goes on');
  assert.equal(info.financialYearEndMonth, 12);
});

function refreshHandler(counter, answer = { access_token: 'access-new', api_domain: 'https://www.zohoapis.eu', token_type: 'Bearer', expires_in: 3600 }) {
  return async request => {
    if (!isToken(request)) return null;
    counter.calls.push(request);
    await new Promise(resolve => setImmediate(resolve)); // let other callers arrive while it is in flight
    return typeof answer === 'function' ? answer(request) : json(answer);
  };
}

test('an expiring token is refreshed once for many concurrent callers, at the stored data centre', async () => {
  storeToken(ORG, { expires_at: toDbText(new Date(Date.now() + 60 * 1000)) }); // inside the 2-minute margin
  const counter = { calls: [] };
  handlers.push(refreshHandler(counter));
  const tokens = await Promise.all(Array.from({ length: 5 }, () => client.getValidAccessToken(ORG)));
  assert.deepEqual(tokens, Array(5).fill('access-new'));
  assert.equal(counter.calls.length, 1, 'one refresh, never several in parallel');
  assert.equal(counter.calls[0].url.origin, 'https://accounts.zoho.eu');
  assert.equal(counter.calls[0].body.grant_type, 'refresh_token');
  assert.equal(counter.calls[0].body.refresh_token, 'refresh-1');
  const row = tokenRows.get(`zoho:${ORG}`);
  assert.equal(row.access_token, 'access-new');
  assert.equal(row.refresh_token, 'refresh-1', 'Zoho refresh tokens do not rotate: the old one is kept');
  assert.equal(row.accounts_server, 'https://accounts.zoho.eu');
  assert.ok(client.parseDbDate(row.expires_at) > Date.now() + 55 * 60 * 1000);
});

test('a token still valid (stored as MySQL UTC text) is used without a refresh', async () => {
  storeToken(ORG, { expires_at: toDbText(new Date(Date.now() + 10 * 60 * 1000)) });
  assert.equal(await client.getValidAccessToken(ORG), 'access-old');
  assert.equal(requests.length, 0);
  assert.equal(client.parseDbDate('2026-11-24 10:00:00'), Date.UTC(2026, 10, 24, 10, 0, 0));
});

test('organisations from one sign-in share a single refresh', async () => {
  storeToken('600000001', { expires_at: past() });
  storeToken('600000002', { expires_at: past() });
  const counter = { calls: [] };
  handlers.push(refreshHandler(counter));
  const [a, b] = await Promise.all([client.getValidAccessToken('600000001'), client.getValidAccessToken('600000002')]);
  assert.equal(a, 'access-new');
  assert.equal(b, 'access-new');
  assert.equal(counter.calls.length, 1, 'Zoho allows only 10 token requests per 10 minutes');
  assert.equal(tokenRows.get('zoho:600000002').access_token, 'access-new');
});

test('a refused refresh is an auth failure; Zoho\'s token throttle is not', async () => {
  storeToken(ORG, { expires_at: past() });
  handlers.push(refreshHandler({ calls: [] }, { error: 'invalid_code' })); // Zoho sends this with HTTP 200
  await assert.rejects(client.getValidAccessToken(ORG), err => err.authFailure === true);

  client.__reset();
  handlers = [refreshHandler({ calls: [] }, () => json({ error: 'invalid_grant' }, 400))];
  await assert.rejects(client.getValidAccessToken(ORG), err => err.authFailure === true);

  client.__reset();
  handlers = [refreshHandler({ calls: [] }, () => json({ error_description: 'You have made too many requests continuously. Please try again after some time.', error: 'Access Denied', status: 'failure' }, 400))];
  await assert.rejects(client.getValidAccessToken(ORG), err => err.authFailure !== true && err.retryLater === true);

  client.__reset();
  handlers = [refreshHandler({ calls: [] }, { error: 'invalid_client' })];
  await assert.rejects(client.getValidAccessToken(ORG), err => err.authFailure !== true && err.configurationError === true);
});

test('a missing token row is an auth failure', async () => {
  await assert.rejects(client.getValidAccessToken('600000999'), err => err.authFailure === true);
});

test('a 401 on an API call forces one refresh and one retry', async () => {
  storeToken(ORG);
  const counter = { calls: [] };
  handlers.push(refreshHandler(counter));
  handlers.push(r => isBooks(r, '/organizations/600000001') && (r.headers.Authorization === 'Zoho-oauthtoken access-old'
    ? json({ code: 57, message: 'You are not authorized to perform this operation' }, 401)
    : json({ code: 0, message: 'success', organization: { name: 'Example Trading Ltd' } })));
  const body = await client.apiGet(ORG, '/organizations/600000001');
  assert.equal(body.organization.name, 'Example Trading Ltd');
  assert.equal(counter.calls.length, 1);

  // Still refused after the refresh: one retry only, then the error.
  client.__reset();
  storeToken(ORG);
  counter.calls = [];
  requests = [];
  handlers = [refreshHandler(counter), r => isBooks(r, '/organizations/600000001') && json({ code: 57, message: 'not authorised' }, 401)];
  await assert.rejects(client.apiGet(ORG, '/organizations/600000001'), /401/);
  assert.equal(counter.calls.length, 1);
  assert.equal(requests.filter(r => isBooks(r, '/organizations/600000001')).length, 2);
});

test('a stored API domain that is not Zoho is never sent the token', async () => {
  storeToken(ORG, { api_domain: 'https://zohoapis.example.test' });
  await assert.rejects(client.apiGet(ORG, '/contacts'), /not a Zoho address/);
  assert.equal(requests.length, 0);
});

test('ledger flags for the shared checks', () => {
  assert.deepEqual(zoho.ledger, { key: 'zoho', purchaseCredits: true, drafts: true, exchangeRates: true });
});
