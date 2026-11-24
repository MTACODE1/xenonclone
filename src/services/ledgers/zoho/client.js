// Sign-in and API calls for Zoho Books clients. Read-only: nothing here changes a client's books.
//
// Zoho keeps each customer's account in one data centre (US, EU, UK, India, Australia, ...). The
// sign-in starts at ZOHO_ACCOUNTS_URL (default accounts.zoho.com); Zoho sends the customer's own
// accounts server back on the callback ("accounts-server"), and the token exchange and every
// refresh must go to that server. The token answer names the API domain to call
// (e.g. https://www.zohoapis.eu). Both are kept with the token (akrio_ledger_tokens).
// Docs: https://www.zoho.com/books/api/v3/oauth/ and
//       https://www.zoho.com/accounts/protocol/oauth/multi-dc.html (read 24 Nov 2026).
const crypto = require('crypto');
const { getLedgerToken, saveLedgerToken } = require('../../../db/ledgerTokens');

const PROVIDER = 'zoho';
const DEFAULT_ACCOUNTS_URL = 'https://accounts.zoho.com';
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const API_CALL_TIMEOUT_MS = 60000;
const MAX_ATTEMPTS = 6;

// Read-only scopes, one per list Verify reads. Vendor credits sit under "debitnotes" in Zoho's
// scope list (List vendor credits needs ZohoBooks.debitnotes.READ); the organisation list and
// details need settings; the transaction lock needs accountants.
const SCOPES = [
  'ZohoBooks.settings.READ',
  'ZohoBooks.invoices.READ',
  'ZohoBooks.bills.READ',
  'ZohoBooks.creditnotes.READ',
  'ZohoBooks.debitnotes.READ',
  'ZohoBooks.contacts.READ',
  'ZohoBooks.accountants.READ',
];

// The accounts-server value arrives on the callback URL, which anyone can type. The client secret
// is sent to it, so only Zoho's own accounts servers are accepted (Zoho's published list of data
// centres), plus whatever ZOHO_ACCOUNTS_URL is set to.
const ZOHO_ACCOUNTS_SERVER = /^https:\/\/accounts\.(zoho\.(com|eu|in|com\.au|jp|sa|uk|ae|com\.cn)|zohocloud\.ca)$/;
// The same for the API domain the token answer names: the access token is sent to it.
const ZOHO_API_DOMAIN = /^https:\/\/(www\.)?zohoapis\.(com|eu|in|com\.au|jp|ca|sa|uk|ae|com\.cn)$/;

function trimSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function defaultAccountsUrl() {
  return trimSlash(process.env.ZOHO_ACCOUNTS_URL) || DEFAULT_ACCOUNTS_URL;
}

function isConfigured() {
  return Boolean(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REDIRECT_URI);
}

// A Zoho accounts server we may send the client secret to, or null.
function safeAccountsServer(value) {
  const url = trimSlash(value);
  if (!url) return null;
  if (url === defaultAccountsUrl() || ZOHO_ACCOUNTS_SERVER.test(url)) return url;
  return null;
}

function safeApiDomain(value) {
  const url = trimSlash(value);
  return ZOHO_API_DOMAIN.test(url) ? url : null;
}

function buildConsentUrl(state) {
  const params = new URLSearchParams({
    scope: SCOPES.join(','),
    client_id: process.env.ZOHO_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.ZOHO_REDIRECT_URI,
    // offline: Zoho returns a refresh token; consent: it returns one even if this app was
    // approved before (without it a second connect comes back with no refresh token).
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${defaultAccountsUrl()}/oauth/v2/auth?${params}`;
}

// Zoho's token endpoint often answers HTTP 200 with {"error": "..."} instead of an error status,
// so the body is checked as well as the status.
async function postToken(accountsServer, form) {
  const response = await fetch(`${accountsServer}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(API_CALL_TIMEOUT_MS),
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch (error) { body = null; }
  return { status: response.status, ok: response.ok, body, text };
}

// Zoho allows only 10 token requests per 10 minutes and answers the 11th with "Access Denied"
// ("too many requests continuously"). That is a pause, not a revoked sign-in: the client must not
// be marked disconnected for it.
function isTokenThrottle(result) {
  const error = String(result.body?.error || '');
  const description = String(result.body?.error_description || result.text || '');
  return /access denied/i.test(error) || /too many requests/i.test(description);
}

async function exchangeCode(code, accountsServer) {
  const result = await postToken(accountsServer, {
    grant_type: 'authorization_code',
    code: String(code || ''),
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    redirect_uri: process.env.ZOHO_REDIRECT_URI,
  });
  if (!result.ok || !result.body || result.body.error || !result.body.access_token) {
    throw new Error(`Zoho sign-in failed: ${result.status} ${result.body?.error || 'no access token in the answer'}`);
  }
  return result.body;
}

// The token object saveLedgerToken stores (see src/db/ledgerTokens.js).
function tokenFromAnswer(answer, { refreshToken, accountsServer, apiDomain }) {
  const expiresIn = Number(answer.expires_in) > 0 ? Number(answer.expires_in) : 3600;
  return {
    access_token: answer.access_token,
    // Zoho refresh tokens do not rotate: a refresh answer has none, so the old one is kept.
    refresh_token: answer.refresh_token || refreshToken,
    expires_at: new Date(Date.now() + expiresIn * 1000),
    refresh_expires_at: null, // Zoho refresh tokens last until revoked
    api_domain: safeApiDomain(answer.api_domain) || apiDomain || null,
    accounts_server: accountsServer,
  };
}

// MySQL hands DATETIME back as 'YYYY-MM-DD HH:MM:SS' (dateStrings), written in UTC by
// ledgerTokens.toMysqlDate. new Date() on that text would read it as local time.
function parseDbDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.getTime();
  const text = String(value);
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// One refresh at a time per sign-in. Several Zoho organisations connected through one sign-in
// share the same refresh token, and Zoho allows only 10 token requests per 10 minutes, so the
// refresh is shared by refresh token (which also covers one organisation's concurrent callers),
// and a token just fetched for one organisation is reused by the others. A parallel refresh
// disconnected clients once (Xero, Oct 2026).
const refreshesInFlight = new Map(); // refresh-token fingerprint -> Promise<token>
const freshTokens = new Map(); // refresh-token fingerprint -> token from the latest refresh

function fingerprint(refreshToken) {
  return crypto.createHash('sha256').update(String(refreshToken)).digest('hex');
}

function stillValid(expiresAtMs) {
  return expiresAtMs != null && Date.now() < expiresAtMs - REFRESH_MARGIN_MS;
}

async function refreshToken(row, rejectedToken) {
  const key = fingerprint(row.refresh_token);
  const recent = freshTokens.get(key);
  if (recent && recent.access_token !== rejectedToken && stillValid(recent.expires_at.getTime())) return recent;
  if (refreshesInFlight.has(key)) return refreshesInFlight.get(key);

  const accountsServer = safeAccountsServer(row.accounts_server) || defaultAccountsUrl();
  const flight = (async () => {
    const result = await postToken(accountsServer, {
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
    });
    if (result.ok && result.body && !result.body.error && result.body.access_token) {
      const token = tokenFromAnswer(result.body, {
        refreshToken: row.refresh_token, accountsServer, apiDomain: safeApiDomain(row.api_domain),
      });
      freshTokens.set(key, token);
      return token;
    }
    const reason = result.body?.error || `HTTP ${result.status}`;
    const error = new Error(`Zoho token refresh failed: ${reason}`);
    if (isTokenThrottle(result)) {
      error.retryLater = true;
    } else if (reason === 'invalid_client') {
      // Verify's own app keys are wrong: every client would fail, and none of them is at fault.
      error.configurationError = true;
    } else if (['invalid_code', 'invalid_grant', 'invalid_token'].includes(reason) ||
      result.status === 400 || result.status === 401) {
      // Revoked or no longer valid: ledgerSync marks the client disconnected.
      error.authFailure = true;
      error.message = `Zoho Books sign-in is no longer valid (${reason}). Reconnect this organisation from the dashboard.`;
    }
    throw error;
  })();
  refreshesInFlight.set(key, flight);
  try {
    return await flight;
  } finally {
    refreshesInFlight.delete(key);
  }
}

// The token and API domain to call one organisation with, refreshed about 2 minutes before it
// expires. force: the last call was refused with 401 for rejectedToken.
async function getConnection(externalId, { force = false, rejectedToken = null } = {}) {
  const row = await getLedgerToken(PROVIDER, externalId);
  if (!row) throw Object.assign(new Error(`No Zoho Books sign-in is stored for organisation ${externalId}`), { authFailure: true });
  const apiDomain = safeApiDomain(row.api_domain);
  if (!apiDomain) throw new Error(`The stored Zoho API domain for organisation ${externalId} is not a Zoho address`);

  const tokenIsRejected = force && (!rejectedToken || rejectedToken === row.access_token);
  if (!tokenIsRejected && stillValid(parseDbDate(row.expires_at))) {
    return { accessToken: row.access_token, apiDomain };
  }
  const token = await refreshToken(row, force ? (rejectedToken || row.access_token) : null);
  if (token.access_token !== row.access_token) {
    await saveLedgerToken(PROVIDER, externalId, { ...token, accounts_server: row.accounts_server || token.accounts_server });
  }
  return { accessToken: token.access_token, apiDomain: token.api_domain || apiDomain };
}

async function getValidAccessToken(externalId) {
  return (await getConnection(externalId)).accessToken;
}

let sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function retryDelay(attempt, retryAfterHeader) {
  const backoff = Math.min(Math.pow(2, attempt) * 1000, 30000);
  const retryAfter = Number(retryAfterHeader);
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(Math.max(retryAfter * 1000, backoff), 120000)
    : backoff;
}

function isNetworkError(error) {
  return ['AbortError', 'TimeoutError'].includes(error?.name) ||
    (error instanceof TypeError && /fetch failed/i.test(error.message)) ||
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(error?.code || error?.cause?.code);
}

// One Zoho Books GET. organization_id goes on every call (Zoho requires it). Transient answers
// (429 and 5xx, timeouts, dropped connections) are retried with backoff that honours Retry-After;
// a 401 gets one forced token refresh and one retry. Zoho's daily call limit (error code 45)
// is not retried: nothing will succeed until the next day.
async function apiGet(externalId, path, params = {}) {
  let forced = false;
  let rejectedToken = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const connection = await getConnection(externalId, { force: Boolean(rejectedToken), rejectedToken });
    rejectedToken = null;
    const url = new URL(`${connection.apiDomain}/books/v3${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    url.searchParams.set('organization_id', String(externalId));

    let response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Zoho-oauthtoken ${connection.accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(API_CALL_TIMEOUT_MS),
      });
    } catch (error) {
      if (isNetworkError(error) && attempt < MAX_ATTEMPTS) {
        await sleep(retryDelay(attempt));
        continue;
      }
      throw error;
    }

    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch (error) { body = null; }

    if (response.status === 401 && !forced) {
      forced = true;
      rejectedToken = connection.accessToken;
      continue;
    }
    if (response.status === 429 && Number(body?.code) === 45) {
      throw Object.assign(new Error(`Zoho Books daily API limit reached for this organisation: ${body?.message || 'try again tomorrow'}`),
        { dailyLimit: true });
    }
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
      const delay = retryDelay(attempt, response.headers.get('retry-after'));
      console.log(`Zoho Books ${response.status} on ${path} (attempt ${attempt}/${MAX_ATTEMPTS}), waiting ${delay}ms...`);
      await sleep(delay);
      continue;
    }
    if (!response.ok) {
      const error = new Error(`Zoho Books ${path} failed: ${response.status} ${body?.message || text.slice(0, 200)}`);
      error.status = response.status;
      error.zohoCode = body?.code;
      throw error;
    }
    // Zoho answers code 0 for success; anything else is an error even with HTTP 200.
    if (!body || Number(body.code) !== 0) {
      throw new Error(`Zoho Books ${path} failed: ${body?.message || 'the answer was not Zoho JSON'}`);
    }
    return body;
  }
  throw new Error(`Zoho Books ${path}: gave up after ${MAX_ATTEMPTS} attempts`);
}

// The organisations a brand-new sign-in can see (no organization_id yet, nothing stored yet).
// GET /books/v3/organizations, scope ZohoBooks.settings.READ.
async function fetchOrganizations(apiDomain, accessToken) {
  const response = await fetch(`${apiDomain}/books/v3/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(API_CALL_TIMEOUT_MS),
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch (error) { body = null; }
  if (!response.ok || !body || Number(body.code) !== 0) {
    throw new Error(`Zoho Books organisation list failed: ${response.status} ${body?.message || text.slice(0, 200)}`);
  }
  return body.organizations || [];
}

// For tests only: no real waiting, and no tokens remembered from an earlier test.
function __setSleep(fn) { sleep = fn; }
function __reset() { refreshesInFlight.clear(); freshTokens.clear(); }

module.exports = {
  SCOPES, isConfigured, buildConsentUrl, defaultAccountsUrl, safeAccountsServer, safeApiDomain,
  exchangeCode, tokenFromAnswer, parseDbDate, getConnection, getValidAccessToken, apiGet,
  fetchOrganizations, __setSleep, __reset,
};
