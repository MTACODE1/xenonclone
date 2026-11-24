// QuickBooks Online sign-in and API calls for one connected company (Intuit calls it a realm).
//
// Checked against Intuit's own docs (24 Nov 2026):
//   OAuth 2.0: developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
//   Queries:   developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries
//   Minor versions 1-74 were retired on 1 Aug 2025; 75 is the base version.
//
// Tokens live in akrio_ledger_tokens (src/db/ledgerTokens.js). Two things about Intuit's tokens
// shape this file:
//   - Access tokens last one hour; refresh tokens roll (100 days) and a NEW refresh token can come
//     back from any refresh. The newest one must always be saved, or the next refresh is refused
//     with invalid_grant and the client has to be reconnected by hand.
//   - Two refreshes of the same connection at once can make Intuit revoke the tokens (its FAQ says
//     so, and a parallel Xero refresh disconnected six clients here once). So there is only ever one
//     refresh per connection in flight in this process; every other caller waits for that one.
const { getLedgerToken, saveLedgerToken } = require('../../../db/ledgerTokens');

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const SCOPE = 'com.intuit.quickbooks.accounting'; // read and write is the only accounting scope Intuit offers; Verify only reads
const MINOR_VERSION = '75';

const REFRESH_MARGIN_MS = 2 * 60 * 1000; // refresh a little before expiry so a long sync does not hit a dead token
const API_TIMEOUT_MS = 60 * 1000;
const MAX_ATTEMPTS = 6;
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

// Tests swap this out so retries do not really wait.
let sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function setSleepForTests(fn) { sleep = fn; }

function apiBase() {
  return process.env.QBO_ENVIRONMENT === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function isConfigured() {
  return Boolean(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET && process.env.QBO_REDIRECT_URI);
}

function buildConsentUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: process.env.QBO_REDIRECT_URI,
    state,
  });
  return `${AUTH_URL}?${params}`;
}

// ledgerTokens.js saves times in UTC, and the MySQL pool hands DATETIME back as a bare string
// ("2026-11-24 10:00:00", dateStrings: true). new Date() would read that as the server's local
// time, so it is read as UTC here explicitly.
function parseStoredTime(value) {
  if (value == null || value === '') return NaN;
  if (value instanceof Date) return value.getTime();
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)) return new Date(`${text.replace(' ', 'T')}Z`).getTime();
  return new Date(text).getTime();
}

// Intuit's token response -> the row shape saveLedgerToken stores.
function tokenFromResponse(body, previousRefreshToken = null) {
  const now = Date.now();
  const expiresIn = Number(body.expires_in);
  const refreshExpiresIn = Number(body.x_refresh_token_expires_in);
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token || previousRefreshToken,
    expires_at: new Date(now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000),
    refresh_expires_at: Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0 ? new Date(now + refreshExpiresIn * 1000) : null,
    api_domain: null,
    accounts_server: null,
  };
}

// One POST to Intuit's token endpoint. A 400/401 (invalid_grant, revoked, expired) means the
// connection itself is no longer accepted: that error carries authFailure so the sync marks the
// client disconnected instead of retrying it every night. A 429/5xx is retried a few times; a
// timeout or network error is NOT retried, because the refresh may already have happened at
// Intuit's end and a second request with the same refresh token is what gets tokens revoked.
async function postToken(form) {
  const basic = Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (response.ok) return response.json();
    const text = await response.text().catch(() => '');
    if (TRANSIENT.has(response.status) && attempt < 3) {
      await sleep(retryDelayMs(attempt, response.headers.get('retry-after')));
      continue;
    }
    const error = new Error(`QuickBooks sign-in was refused (${response.status}): ${text.slice(0, 300)}`);
    error.status = response.status;
    // Only a refused connection (invalid_grant: revoked, expired or already-used refresh token)
    // means the client must sign in again. invalid_client means our own app keys are wrong (a
    // rotated or missing QBO_CLIENT_SECRET): that must not mark every QuickBooks client disconnected.
    if (/invalid_client/i.test(text)) error.configurationError = true;
    else if (/invalid_grant/i.test(text)) error.authFailure = true;
    throw error;
  }
}

async function exchangeCode(code) {
  const body = await postToken({ grant_type: 'authorization_code', code, redirect_uri: process.env.QBO_REDIRECT_URI });
  if (!body.access_token || !body.refresh_token) throw new Error('QuickBooks did not return a sign-in token');
  return tokenFromResponse(body);
}

const refreshesInFlight = new Map(); // externalId -> Promise<access token>

// The one refresh for this connection. It re-reads the saved row first: if another caller has just
// refreshed (the saved token is in date and is not the one QuickBooks rejected), that token is used
// rather than spending the refresh token a second time.
function refreshOnce(externalId, rejectedAccessToken = null) {
  const key = String(externalId);
  if (refreshesInFlight.has(key)) return refreshesInFlight.get(key);
  const run = (async () => {
    const row = await getLedgerToken('quickbooks', key);
    if (!row) throw Object.assign(new Error(`QuickBooks is not connected for company ${key}`), { authFailure: true });
    if (row.access_token !== rejectedAccessToken &&
        parseStoredTime(row.expires_at) - REFRESH_MARGIN_MS > Date.now()) {
      return row.access_token;
    }
    const body = await postToken({ grant_type: 'refresh_token', refresh_token: row.refresh_token });
    if (!body.access_token) throw new Error('QuickBooks refresh returned no access token');
    const token = tokenFromResponse(body, row.refresh_token);
    await saveLedgerToken('quickbooks', key, token);
    return token.access_token;
  })();
  refreshesInFlight.set(key, run);
  const clear = () => { if (refreshesInFlight.get(key) === run) refreshesInFlight.delete(key); };
  run.then(clear, clear);
  return run;
}

async function getValidAccessToken(externalId) {
  const key = String(externalId);
  if (refreshesInFlight.has(key)) return refreshesInFlight.get(key);
  const row = await getLedgerToken('quickbooks', key);
  if (!row) throw Object.assign(new Error(`QuickBooks is not connected for company ${key}`), { authFailure: true });
  if (parseStoredTime(row.expires_at) - REFRESH_MARGIN_MS > Date.now()) return row.access_token;
  return refreshOnce(key);
}

// Waits before a retry: Intuit's Retry-After (seconds) when it sends one, never less than the
// normal backoff, capped at two minutes.
function retryDelayMs(attempt, retryAfterHeader) {
  const backoff = Math.min(Math.pow(2, attempt) * 1000, 30000);
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(Math.max(retryAfter * 1000, backoff), 120000);
  return backoff;
}

// GET /v3/company/<realmId><path>. Always asks for JSON and minorversion 75. Retries 429/5xx and
// timeouts (a GET is safe to repeat); a 401 gets one forced token refresh and one more try.
async function apiGet(externalId, path, params = {}) {
  const url = new URL(`${apiBase()}/v3/company/${encodeURIComponent(String(externalId))}${path}`);
  for (const [name, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(name, value);
  }
  url.searchParams.set('minorversion', MINOR_VERSION);

  let refreshedAfter401 = false;
  for (let attempt = 1; ; attempt++) {
    const accessToken = await getValidAccessToken(externalId);
    let response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      if (attempt < MAX_ATTEMPTS && (timedOut || error.code === 'ECONNRESET' || error.cause?.code === 'ECONNRESET')) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      throw timedOut ? new Error(`QuickBooks API call timed out after ${API_TIMEOUT_MS}ms: ${path}`) : error;
    }

    if (response.status === 401 && !refreshedAfter401) {
      refreshedAfter401 = true;
      await refreshOnce(externalId, accessToken);
      attempt--; // the forced refresh is not a failed attempt
      continue;
    }
    if (TRANSIENT.has(response.status) && attempt < MAX_ATTEMPTS) {
      await sleep(retryDelayMs(attempt, response.headers.get('retry-after')));
      continue;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const error = new Error(`QuickBooks API ${path} failed (${response.status}): ${text.slice(0, 500)}`);
      error.status = response.status;
      // Still 401 after a fresh token: Intuit no longer accepts this connection.
      if (response.status === 401) error.authFailure = true;
      throw error;
    }
    return response.json();
  }
}

module.exports = {
  AUTH_URL, TOKEN_URL, SCOPE, MINOR_VERSION,
  apiBase, isConfigured, buildConsentUrl, exchangeCode, getValidAccessToken, apiGet,
  parseStoredTime, retryDelayMs, setSleepForTests,
};
