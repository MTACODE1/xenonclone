// QuickBooks Online provider: sign-in, token refresh, paging and the mapping to Xero shapes.
// A fake Intuit (token endpoint + Accounting API, answering in the JSON shapes Intuit's reference
// pages show) stands in through global.fetch, and the token table is an in-memory stand-in, so
// nothing here reaches QuickBooks or a database. Made-up data only.
const test = require('node:test');
const assert = require('node:assert/strict');

// ---- token table stand-in ----
const tokens = new Map();
const saves = [];
const tokensPath = require.resolve('../src/db/ledgerTokens');
require.cache[tokensPath] = {
  id: tokensPath, filename: tokensPath, loaded: true,
  exports: {
    getLedgerToken: async (provider, externalId) => {
      await new Promise(resolve => setImmediate(resolve)); // a real look-up is never synchronous
      const row = tokens.get(`${provider}:${externalId}`);
      return row ? { ...row } : null;
    },
    saveLedgerToken: async (provider, externalId, token) => {
      saves.push({ provider, externalId, token });
      const toDb = v => (v ? new Date(v).toISOString().slice(0, 19).replace('T', ' ') : null);
      tokens.set(`${provider}:${externalId}`, {
        provider, external_id: externalId, access_token: token.access_token, refresh_token: token.refresh_token,
        expires_at: toDb(token.expires_at), refresh_expires_at: toDb(token.refresh_expires_at),
      });
    },
    deleteLedgerToken: async () => {},
  },
};

process.env.QBO_CLIENT_ID = 'test-client-id';
process.env.QBO_CLIENT_SECRET = 'test-client-secret';
process.env.QBO_REDIRECT_URI = 'https://verify.example.test/auth/quickbooks/callback';
delete process.env.QBO_ENVIRONMENT;

const client = require('../src/services/ledgers/quickbooks/client');
const qbo = require('../src/services/ledgers/quickbooks');
const sleeps = [];
client.setSleepForTests(async ms => { sleeps.push(ms); });

// ---- fake Intuit ----
const REALM = '9130000000001';
let store = {};              // entity -> rows
let tokenReplies = [];       // queued replies for the token endpoint
let apiOverrides = [];       // queued special replies for API calls: (url) => Response | null
const tokenCalls = [];
const apiCalls = [];
let lieAboutCount = 0;       // when set, the API returns this many fewer rows than it counts

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function answerQuery(statement) {
  const count = /^SELECT COUNT\(\*\) FROM (\w+)/i.exec(statement);
  const select = /^SELECT \* FROM (\w+)/i.exec(statement);
  const entity = (count || select)[1];
  let rows = store[entity] || [];
  const where = /WHERE (.*?)(?: STARTPOSITION|$)/i.exec(statement)?.[1] || '';
  // Like QuickBooks: without "Active IN (true, false)" a list entity returns active rows only.
  if (['Customer', 'Vendor'].includes(entity) && !/Active IN \(true, false\)/i.test(where)) rows = rows.filter(r => r.Active !== false);
  if (entity === 'Attachable' && /EntityRef\.Type = 'Bill'/i.test(where)) {
    rows = rows.filter(r => (r.AttachableRef || []).some(ref => ref.EntityRef.type === 'Bill'));
  }
  if (count) return json(200, { QueryResponse: { totalCount: rows.length }, time: '2026-11-24T10:00:00.000-08:00' });
  const start = Number(/STARTPOSITION (\d+)/i.exec(statement)?.[1] || 1);
  const max = Math.min(Number(/MAXRESULTS (\d+)/i.exec(statement)?.[1] || 100), 1000);
  const servable = rows.slice(0, rows.length - lieAboutCount);
  const page = servable.slice(start - 1, start - 1 + max);
  // An empty page has no entity key at all, as QuickBooks answers.
  const response = page.length ? { startPosition: start, [entity]: page, maxResults: page.length } : {};
  return json(200, { QueryResponse: response, time: '2026-11-24T10:00:00.000-08:00' });
}

global.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.href === client.TOKEN_URL) {
    const form = new URLSearchParams(String(init.body));
    tokenCalls.push({ headers: init.headers, form: Object.fromEntries(form) });
    const reply = tokenReplies.shift();
    if (!reply) throw new Error('unexpected token request');
    if (reply.delay) await new Promise(resolve => setTimeout(resolve, reply.delay));
    return json(reply.status || 200, reply.body);
  }
  assert.equal(url.origin, 'https://sandbox-quickbooks.api.intuit.com', 'sandbox unless QBO_ENVIRONMENT=production');
  apiCalls.push({ path: url.pathname, query: url.searchParams.get('query'), minorversion: url.searchParams.get('minorversion'), auth: init.headers?.Authorization });
  for (const override of apiOverrides) {
    const reply = override(url, init);
    if (reply) { apiOverrides = apiOverrides.filter(o => o !== override || override.keep); return reply; }
  }
  if (url.pathname.endsWith('/query')) return answerQuery(url.searchParams.get('query'));
  if (url.pathname === `/v3/company/${REALM}/companyinfo/${REALM}`) return json(200, { CompanyInfo: store.CompanyInfo, time: 'x' });
  if (url.pathname === `/v3/company/${REALM}/preferences`) return json(200, { Preferences: store.Preferences, time: 'x' });
  return json(404, { Fault: { Error: [{ Message: 'not found' }], type: 'ValidationFault' } });
};

const inAnHour = () => new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
const expired = () => new Date(Date.now() - 1000).toISOString().slice(0, 19).replace('T', ' ');
function seedToken(extra = {}) {
  tokens.set(`quickbooks:${REALM}`, { access_token: 'access-old', refresh_token: 'refresh-old', expires_at: inAnHour(), ...extra });
}

test.beforeEach(() => {
  tokens.clear(); saves.length = 0; tokenCalls.length = 0; apiCalls.length = 0; sleeps.length = 0;
  tokenReplies = []; apiOverrides = []; store = {}; lieAboutCount = 0;
  seedToken();
});

// ---- made-up documents in Intuit's documented JSON shapes ----
const customer = (id, name, extra = {}) => ({ Id: String(id), DisplayName: name, Active: true, PrimaryEmailAddr: { Address: `${id}@example.test` }, SyncToken: '0', ...extra });
const vendor = (id, name, extra = {}) => ({ Id: String(id), DisplayName: name, Active: true, SyncToken: '0', ...extra });
const invoice = (id, extra = {}) => ({
  Id: String(id), DocNumber: `INV-${id}`, TxnDate: '2026-08-01', DueDate: '2026-08-31',
  TotalAmt: 120, Balance: 120, CustomerRef: { value: '5', name: 'Made Up Customer' },
  TxnTaxDetail: { TotalTax: 20 }, CurrencyRef: { value: 'GBP', name: 'British Pound Sterling' },
  Line: [
    { Id: '1', LineNum: 1, Description: 'Consulting', Amount: 100, DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1', name: 'Services' }, UnitPrice: 50, Qty: 2, TaxCodeRef: { value: '3' }, ItemAccountRef: { value: '79', name: 'Sales' } } },
    { Amount: 100, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
  ],
  ...extra,
});
const bill = (id, extra = {}) => ({
  Id: String(id), DocNumber: `B-${id}`, TxnDate: '2026-08-02', DueDate: '2026-09-01',
  TotalAmt: 60, Balance: 60, VendorRef: { value: '5', name: 'Made Up Supplier' },
  TxnTaxDetail: { TotalTax: 10 }, CurrencyRef: { value: 'GBP' },
  Line: [{ Id: '1', Description: 'Paper', Amount: 50, DetailType: 'AccountBasedExpenseLineDetail',
    AccountBasedExpenseLineDetail: { AccountRef: { value: '64', name: 'Office costs' }, TaxCodeRef: { value: '7' } } }],
  ...extra,
});

test('isConfigured needs all three app settings; the consent URL asks only for the accounting scope', () => {
  assert.equal(qbo.isConfigured(), true);
  const saved = process.env.QBO_REDIRECT_URI;
  delete process.env.QBO_REDIRECT_URI;
  assert.equal(qbo.isConfigured(), false);
  process.env.QBO_REDIRECT_URI = saved;

  const url = new URL(qbo.buildConsentUrl('state-123'));
  assert.equal(`${url.origin}${url.pathname}`, 'https://appcenter.intuit.com/connect/oauth2');
  assert.equal(url.searchParams.get('client_id'), 'test-client-id');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
  assert.equal(url.searchParams.get('redirect_uri'), process.env.QBO_REDIRECT_URI);
  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.deepEqual(qbo.ledger, { key: 'quickbooks', purchaseCredits: true, drafts: false });
});

test('completeConnection swaps the code for tokens with Basic auth, names the company, and writes nothing', async () => {
  tokens.clear();
  tokenReplies.push({ body: { token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh-new', x_refresh_token_expires_in: 8640000, access_token: 'access-new' } });
  store.CompanyInfo = { Id: '1', CompanyName: 'Made Up Bakery Ltd', FiscalYearStartMonth: 'April' };
  apiOverrides.push(url => (url.pathname.endsWith(`/companyinfo/${REALM}`) ? json(200, { CompanyInfo: store.CompanyInfo }) : null));

  const before = Date.now();
  const companies = await qbo.completeConnection({ code: 'auth-code-1', state: 's', realmId: REALM });
  assert.equal(companies.length, 1);
  const [company] = companies;
  assert.equal(company.externalId, REALM);
  assert.equal(company.name, 'Made Up Bakery Ltd');
  assert.equal(company.token.access_token, 'access-new');
  assert.equal(company.token.refresh_token, 'refresh-new');
  assert.ok(Math.abs(new Date(company.token.expires_at).getTime() - (before + 3600e3)) < 5000);
  assert.ok(Math.abs(new Date(company.token.refresh_expires_at).getTime() - (before + 8640000e3)) < 5000);
  assert.equal(company.token.api_domain, null);
  assert.equal(company.token.accounts_server, null);

  const call = tokenCalls[0];
  assert.equal(call.form.grant_type, 'authorization_code');
  assert.equal(call.form.code, 'auth-code-1');
  assert.equal(call.form.redirect_uri, process.env.QBO_REDIRECT_URI);
  assert.equal(call.headers.Authorization, `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`);
  assert.equal(apiCalls[0].auth, 'Bearer access-new', 'the company is looked up with the new, unsaved token');
  assert.equal(saves.length, 0, 'the route saves the token, not the provider');
});

test('completeConnection refuses a callback without a realm id or code', async () => {
  await assert.rejects(qbo.completeConnection({ code: 'x' }), /which company/);
  await assert.rejects(qbo.completeConnection({ realmId: REALM }), /sign-in code/);
  assert.equal(tokenCalls.length, 0);
});

test('documents map to Xero shapes: statuses, ids, contacts, attachments, credits', async () => {
  store.Customer = [customer(5, 'Made Up Customer'), customer(6, 'Old Customer', { Active: false })];
  store.Vendor = [vendor(5, 'Made Up Supplier'), vendor(7, 'Gone Supplier', { Active: false })];
  store.Invoice = [
    invoice(1),                                                         // open
    invoice(2, { Balance: 0 }),                                         // paid
    invoice(3, { Balance: 40 }),                                        // part paid
    invoice(4, { TotalAmt: 0, Balance: 0, TxnTaxDetail: { TotalTax: 0 }, PrivateNote: 'Voided - raised twice' }), // void
    invoice(5, { CustomerRef: { value: '6', name: 'Old Customer' }, CurrencyRef: { value: 'EUR' }, ExchangeRate: 0.8 }),
  ];
  store.Bill = [bill(1), bill(2, { Balance: 0 }), bill(5)];
  store.Attachable = [
    { Id: '900', FileName: 'receipt.pdf', AttachableRef: [{ IncludeOnSend: false, EntityRef: { type: 'Bill', value: '1' } }] },
    { Id: '901', Note: 'a note only', AttachableRef: [{ EntityRef: { type: 'Bill', value: '5' } }] },
    { Id: '902', FileName: 'other.pdf', AttachableRef: [{ EntityRef: { type: 'Invoice', value: '5' } }] },
  ];
  store.CreditMemo = [
    { Id: '1', DocNumber: 'CN-1', TxnDate: '2026-07-01', TotalAmt: 100, RemainingCredit: 30, Balance: 30, CustomerRef: { value: '5', name: 'Made Up Customer' }, TxnTaxDetail: { TotalTax: 0 }, Line: [] },
    { Id: '2', DocNumber: 'CN-2', TxnDate: '2026-07-02', TotalAmt: 50, RemainingCredit: 0, Balance: 0, CustomerRef: { value: '5' }, TxnTaxDetail: { TotalTax: 0 }, Line: [] },
  ];
  store.VendorCredit = [
    { Id: '1', DocNumber: 'VC-1', TxnDate: '2026-07-03', TotalAmt: 90, Balance: 90, VendorRef: { value: '5', name: 'Made Up Supplier' }, Line: [] },
    { Id: '2', TxnDate: '2026-07-04', TotalAmt: 25, Balance: 0, VendorRef: { value: '7' }, Line: [] },
  ];

  const progress = [];
  const docs = await qbo.fetchDocuments(REALM, { emit: e => progress.push(e.step) });
  assert.ok(progress.length >= 3);

  // contacts: inactive ones included, customer 5 and vendor 5 kept apart
  assert.deepEqual(docs.contacts.map(c => [c.contactID, c.contactStatus]), [
    ['c-5', 'ACTIVE'], ['c-6', 'ARCHIVED'], ['v-5', 'ACTIVE'], ['v-7', 'ARCHIVED'],
  ]);
  assert.equal(docs.contacts[0].emailAddress, '5@example.test');

  const inv = Object.fromEntries(docs.invoices.map(i => [i.invoiceID, i]));
  assert.equal(inv['1'].status, 'AUTHORISED');
  assert.equal(inv['1'].type, 'ACCREC');
  assert.equal(inv['1'].invoiceNumber, 'INV-1');
  assert.equal(inv['1'].amountDue, 120);
  assert.equal(inv['1'].subTotal, 100);
  assert.equal(inv['1'].totalTax, 20);
  assert.equal(inv['1'].date, '2026-08-01');
  assert.deepEqual(inv['1'].contact, { contactID: 'c-5', name: 'Made Up Customer' });
  assert.deepEqual(inv['1'].lineItems, [{ description: 'Consulting', quantity: 2, unitAmount: 50, lineAmount: 100, accountCode: '79', taxType: '3' }], 'the sub-total line is left out');
  assert.equal(inv['2'].status, 'PAID');
  assert.equal(inv['2'].amountPaid, 120);
  assert.equal(inv['3'].status, 'AUTHORISED');
  assert.equal(inv['3'].amountPaid, 80);
  assert.equal(inv['4'].status, 'VOIDED');
  assert.equal(inv['4'].amountDue, 0);
  assert.equal(inv['5'].contact.contactID, 'c-6');
  assert.equal(inv['5'].currencyCode, 'EUR');
  assert.equal(inv['5'].currencyRate, 1.25, 'QuickBooks home-per-foreign 0.8 becomes Xero foreign-per-home 1.25');
  assert.equal(inv['1'].currencyRate, undefined);

  const bills = Object.fromEntries(docs.bills.map(b => [b.invoiceID, b]));
  assert.deepEqual(Object.keys(bills).sort(), ['bill-1', 'bill-2', 'bill-5']);
  assert.equal(bills['bill-1'].type, 'ACCPAY');
  assert.equal(bills['bill-1'].status, 'AUTHORISED');
  assert.equal(bills['bill-1'].amountDue, 60);
  assert.equal(bills['bill-1'].hasAttachments, true);
  assert.equal(bills['bill-5'].hasAttachments, false, 'a note is not a document');
  assert.equal(bills['bill-2'].status, 'PAID');
  assert.equal(bills['bill-2'].hasAttachments, false);
  assert.deepEqual(bills['bill-1'].contact, { contactID: 'v-5', name: 'Made Up Supplier' });
  assert.equal(bills['bill-1'].lineItems[0].accountCode, '64');
  assert.equal(bills['bill-1'].lineItems[0].quantity, 1);
  const allIds = [...docs.invoices, ...docs.bills].map(d => d.invoiceID);
  assert.equal(new Set(allIds).size, allIds.length, 'invoice 5 and bill 5 do not collide');
  const attachQuery = apiCalls.find(c => /FROM Attachable WHERE/i.test(c.query || '') && /STARTPOSITION/.test(c.query));
  assert.match(attachQuery.query, /AttachableRef\.EntityRef\.Type = 'Bill'/);
  assert.equal(apiCalls.filter(c => /FROM Attachable/i.test(c.query || '')).length, 2, 'one count and one page, not one query per bill');

  const credits = Object.fromEntries(docs.credits.map(c => [c.creditNoteID, c]));
  assert.equal(credits['1'].type, 'ACCRECCREDIT');
  assert.equal(credits['1'].status, 'AUTHORISED');
  assert.equal(credits['1'].remainingCredit, 30);
  assert.equal(credits['1'].total, 100);
  assert.equal(credits['2'].status, 'PAID');
  assert.equal(credits['vc-1'].type, 'ACCPAYCREDIT');
  assert.equal(credits['vc-1'].remainingCredit, 90);
  assert.equal(credits['vc-1'].status, 'AUTHORISED');
  assert.deepEqual(credits['vc-1'].contact, { contactID: 'v-5', name: 'Made Up Supplier' });
  assert.equal(credits['vc-2'].status, 'PAID');
  assert.equal(credits['vc-2'].contact.name, 'Gone Supplier', 'the name comes from the vendor list when the reference has none');

  for (const call of apiCalls) assert.equal(call.minorversion, '75');
  assert.ok(apiCalls.some(c => /FROM Customer WHERE Active IN \(true, false\)/.test(c.query || '')));
  assert.ok(apiCalls.some(c => /FROM Vendor WHERE Active IN \(true, false\)/.test(c.query || '')));
});

test('credits stay positive even when a figure arrives negative', () => {
  const credit = qbo.mapVendorCredit({ Id: '9', TxnDate: '2026-01-01', TotalAmt: -40, Balance: -40, VendorRef: { value: '1' } }, new Map());
  assert.equal(credit.total, 40);
  assert.equal(credit.remainingCredit, 40);
  assert.equal(credit.status, 'AUTHORISED');
  const voided = qbo.mapCreditMemo({ Id: '8', TxnDate: '2026-01-01', TotalAmt: 0, RemainingCredit: 0, CustomerRef: { value: '1' } }, new Map());
  assert.equal(voided.status, 'VOIDED');
});

test('every page is read: 2,500 invoices take three pages of 1,000', async () => {
  store.Invoice = Array.from({ length: 2500 }, (_, i) => invoice(i + 1));
  const rows = await qbo.queryAll(REALM, 'Invoice');
  assert.equal(rows.length, 2500);
  const pages = apiCalls.filter(c => /^SELECT \* FROM Invoice/.test(c.query || '')).map(c => c.query);
  assert.deepEqual(pages, [
    'SELECT * FROM Invoice STARTPOSITION 1 MAXRESULTS 1000',
    'SELECT * FROM Invoice STARTPOSITION 1001 MAXRESULTS 1000',
    'SELECT * FROM Invoice STARTPOSITION 2001 MAXRESULTS 1000',
  ]);
});

test('an exact 1,000 reads one empty page and stops; an empty list is fine', async () => {
  store.Bill = Array.from({ length: 1000 }, (_, i) => bill(i + 1));
  assert.equal((await qbo.queryAll(REALM, 'Bill')).length, 1000);
  assert.equal(apiCalls.filter(c => /^SELECT \* FROM Bill/.test(c.query || '')).length, 2);
  assert.deepEqual(await qbo.queryAll(REALM, 'CreditMemo'), []);
});

test('a list shorter than QuickBooks counted is refused, not used', async () => {
  store.Invoice = Array.from({ length: 30 }, (_, i) => invoice(i + 1));
  lieAboutCount = 3;
  await assert.rejects(qbo.queryAll(REALM, 'Invoice'), /read 27 of 30 rows/);
});

test('if the attachment filter is refused, every attachment is read and filtered here', async () => {
  store.Customer = []; store.Vendor = []; store.Invoice = []; store.CreditMemo = []; store.VendorCredit = [];
  store.Bill = [bill(1), bill(2)];
  store.Attachable = [
    { Id: '1', FileName: 'a.pdf', AttachableRef: [{ EntityRef: { type: 'Bill', value: '2' } }] },
    { Id: '2', FileName: 'b.pdf', AttachableRef: [{ EntityRef: { type: 'Purchase', value: '1' } }] },
  ];
  apiOverrides.push(url => (/Attachable WHERE/i.test(url.searchParams.get('query') || '')
    ? json(400, { Fault: { Error: [{ Message: 'QueryValidationError', code: '4001' }], type: 'ValidationFault' } }) : null));
  const docs = await qbo.fetchDocuments(REALM);
  const byId = Object.fromEntries(docs.bills.map(b => [b.invoiceID, b.hasAttachments]));
  assert.deepEqual(byId, { 'bill-1': false, 'bill-2': true });
});

test('company info: year end is the month before the start month, close date is the lock date', async () => {
  store.CompanyInfo = { Id: '1', CompanyName: 'Made Up Bakery Ltd', FiscalYearStartMonth: 'April' };
  store.Preferences = { AccountingInfoPrefs: { BookCloseDate: '2026-03-31' }, CurrencyPrefs: { HomeCurrency: { value: 'GBP' }, MultiCurrencyEnabled: false } };
  assert.deepEqual(await qbo.fetchCompanyInfo(REALM), {
    name: 'Made Up Bakery Ltd', lockDate: '2026-03-31', financialYearEndDay: 31, financialYearEndMonth: 3, baseCurrency: 'GBP',
  });
  store.CompanyInfo.FiscalYearStartMonth = 'January';
  store.Preferences = { AccountingInfoPrefs: {}, CurrencyPrefs: { HomeCurrency: { value: 'USD' } } };
  const info = await qbo.fetchCompanyInfo(REALM);
  assert.equal(info.financialYearEndMonth, 12);
  assert.equal(info.financialYearEndDay, 31);
  assert.equal(info.lockDate, null);
  store.CompanyInfo.FiscalYearStartMonth = 'May';
  assert.equal((await qbo.fetchCompanyInfo(REALM)).financialYearEndDay, 30);
});

test('an expired token is refreshed once for many callers at the same time, and the new refresh token is kept', async () => {
  seedToken({ expires_at: expired() });
  tokenReplies.push({ delay: 20, body: { token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh-rotated', x_refresh_token_expires_in: 8640000, access_token: 'access-fresh' } });
  const results = await Promise.all(Array.from({ length: 5 }, () => client.getValidAccessToken(REALM)));
  assert.deepEqual(results, Array(5).fill('access-fresh'));
  assert.equal(tokenCalls.length, 1, 'one refresh, never several in parallel');
  assert.equal(tokenCalls[0].form.grant_type, 'refresh_token');
  assert.equal(tokenCalls[0].form.refresh_token, 'refresh-old');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].token.refresh_token, 'refresh-rotated');
  assert.ok(saves[0].token.refresh_expires_at instanceof Date);
  // The next call uses the saved token without refreshing again.
  assert.equal(await client.getValidAccessToken(REALM), 'access-fresh');
  assert.equal(tokenCalls.length, 1);
});

test('a token within two minutes of expiry is refreshed before use', async () => {
  seedToken({ expires_at: new Date(Date.now() + 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') });
  tokenReplies.push({ body: { expires_in: 3600, refresh_token: 'r2', access_token: 'a2' } });
  assert.equal(await client.getValidAccessToken(REALM), 'a2');
  assert.equal(tokenCalls.length, 1);
});

test('a refused refresh (invalid_grant) is an auth failure, so the client is marked disconnected', async () => {
  seedToken({ expires_at: expired() });
  tokenReplies.push({ status: 400, body: { error: 'invalid_grant' } });
  await assert.rejects(client.getValidAccessToken(REALM), err => err.authFailure === true && /refused \(400\)/.test(err.message));
  assert.equal(saves.length, 0);
  assert.equal(tokenCalls.length, 1, 'a refused refresh is not retried');
});

test('a connection with no saved token is an auth failure', async () => {
  tokens.clear();
  await assert.rejects(client.getValidAccessToken(REALM), err => err.authFailure === true);
});

test('a 401 from the API forces one refresh and one retry; a second 401 is an auth failure', async () => {
  store.Invoice = [invoice(1)];
  apiOverrides.push(url => (url.pathname.endsWith('/query') ? json(401, { fault: { error: [{ message: 'AuthenticationFailed', code: '3200' }], type: 'AUTHENTICATION' } }) : null));
  tokenReplies.push({ body: { expires_in: 3600, refresh_token: 'r3', access_token: 'a3' } });
  const rows = await qbo.queryAll(REALM, 'Invoice');
  assert.equal(rows.length, 1);
  assert.equal(tokenCalls.length, 1);
  assert.equal(apiCalls[0].auth, 'Bearer access-old');
  assert.equal(apiCalls[1].auth, 'Bearer a3');

  const always401 = () => json(401, { fault: { error: [{ message: 'AuthenticationFailed' }] } });
  always401.keep = true;
  apiOverrides = [always401];
  tokenReplies.push({ body: { expires_in: 3600, refresh_token: 'r4', access_token: 'a4' } });
  await assert.rejects(client.apiGet(REALM, '/preferences'), err => err.authFailure === true && err.status === 401);
  assert.equal(tokenCalls.length, 2, 'only one forced refresh per call');
});

test('429 and 5xx are retried, honouring Retry-After; a 400 is not', async () => {
  store.Preferences = { CurrencyPrefs: { HomeCurrency: { value: 'GBP' } } };
  apiOverrides.push(() => json(429, { fault: {} }, { 'retry-after': '7' }));
  apiOverrides.push(() => json(503, { fault: {} }));
  const body = await client.apiGet(REALM, '/preferences');
  assert.equal(body.Preferences.CurrencyPrefs.HomeCurrency.value, 'GBP');
  assert.equal(apiCalls.length, 3);
  assert.equal(sleeps[0], 7000, 'Retry-After seconds are honoured');
  assert.ok(sleeps[1] > 0);

  apiOverrides.push(() => json(400, { Fault: { Error: [{ Message: 'bad query' }] } }));
  await assert.rejects(client.apiGet(REALM, '/query', { query: 'SELECT * FROM Nope' }), err => err.status === 400);
});

test('saved expiry times are read as UTC, as ledgerTokens.js writes them', () => {
  assert.equal(client.parseStoredTime('2026-11-24 10:00:00'), Date.UTC(2026, 10, 24, 10, 0, 0));
  assert.equal(client.parseStoredTime('2026-11-24T10:00:00.000Z'), Date.UTC(2026, 10, 24, 10, 0, 0));
});

test('the ledger registry finds this provider', () => {
  const ledgers = require('../src/services/ledgers');
  assert.equal(ledgers.provider('quickbooks'), qbo);
  assert.equal(ledgers.ledgerReady('quickbooks'), true);
  assert.equal(ledgers.identifierFor('quickbooks', REALM), `qbo-${REALM}`);
});

// ---- review fixes, 24 Nov 2026 ----
test('a realm id the new token cannot read is refused and nothing is returned to save', async () => {
  tokens.clear();
  tokenReplies.push({ body: { expires_in: 3600, refresh_token: 'refresh-new', x_refresh_token_expires_in: 8640000, access_token: 'access-new' } });
  // Intuit answers 403 when the token belongs to another company than the realm in the URL.
  apiOverrides.push(url => (url.pathname.includes('/companyinfo/') ? json(403, { Fault: { Error: [{ Message: 'AuthorizationFailed' }] } }) : null));
  await assert.rejects(qbo.completeConnection({ code: 'c', state: 's', realmId: REALM }), /did not confirm the company.*nothing was saved/);
  assert.equal(saves.length, 0);
});

test('wrong app keys (invalid_client) are a set-up problem, not a client who disconnected', async () => {
  seedToken({ expires_at: expired() });
  tokenReplies.push({ status: 401, body: { error: 'invalid_client' } });
  await assert.rejects(client.getValidAccessToken(REALM), err => err.configurationError === true && err.authFailure !== true);
  const { isAuthFailure } = require('../src/services/ledgerSync');
  try { await client.getValidAccessToken(REALM); } catch (err) { assert.equal(isAuthFailure(err), false); }
});

test('contacts say whether they are customers or suppliers', async () => {
  store = { Customer: [customer(5, 'Made Up Customer')], Vendor: [vendor(5, 'Made Up Supplier')], Invoice: [], Bill: [], CreditMemo: [], VendorCredit: [], Attachable: [] };
  const { contacts } = await qbo.fetchDocuments(REALM, { emit: () => {} });
  const byId = Object.fromEntries(contacts.map(c => [c.contactID, c]));
  assert.equal(byId['c-5'].isCustomer, true);
  assert.equal(byId['c-5'].isSupplier, false);
  assert.equal(byId['v-5'].isSupplier, true);
  assert.equal(byId['v-5'].isCustomer, false);
});
