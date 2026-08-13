const { XeroClient } = require('xero-node');
const {
  getToken, upsertTokenForConnection, markConnectionDisconnected, getTenantsSharingRefreshToken,
} = require('../db/queries');

// Xero is replacing broad scopes with granular ones; broad scopes keep working only until
// September 2027. Both forms are requested during the transition because scopes are additive and
// dropping the broad ones would break connections that were authorised with them.
//
// Every scope below maps to an endpoint this app actually calls:
//   settings      -> Organisations, Accounts, TaxRates
//   contacts      -> Contacts
//   invoices      -> Invoices, CreditNotes
//   banktransactions -> BankTransactions, BankTransfers
//   payments      -> Payments (and their batchPayment data)
//   manualjournals-> ManualJournals
//   journals      -> Journals (general ledger; the transaction-count card). NOT covered by
//                    manualjournals, which is a different endpoint — without this the journal
//                    fetch 403s and the count silently falls back to zero.
//   reports.balancesheet -> Reports/BalanceSheet (opening-balance comparison)
//   reports.banksummary  -> Reports/BankSummary (the Xero side of bank_balance). Previously relied
//                    on the deprecated broad accounting.reports.read, so bank_balance would have
//                    lost its Xero balance when broad scopes retire.
function createXeroClient() {
  return new XeroClient({
    clientId: process.env.XERO_CLIENT_ID,
    clientSecret: process.env.XERO_CLIENT_SECRET,
    redirectUris: [process.env.XERO_REDIRECT_URI],
    scopes: [
      'openid', 'profile', 'email', 'offline_access',
      'accounting.settings.read',
      'accounting.contacts.read',
      'accounting.invoices.read',
      'accounting.banktransactions.read',
      'accounting.manualjournals.read',
      'accounting.journals.read',
      'accounting.payments.read',
      'accounting.reports.read',
      'accounting.reports.balancesheet.read',
      'accounting.reports.banksummary.read',
    ],
  });
}

// Only a rejected authorisation means the connection is gone. A dropped socket or a 5xx during the
// refresh call must not be recorded as "disconnected" — that previously required a manual reconnect
// after nothing worse than a network blip, because the wrapped error also hid the transient cause
// from apiCall's retry logic.
function isAuthorisationFailure(err) {
  const code = err?.error || err?.body?.error || '';
  if (code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client') return true;
  if (err?.response?.statusCode === 400 && /invalid_grant/i.test(JSON.stringify(err.body || ''))) return true;
  return /invalid_grant|invalid_client|unauthorized_client|token (has been )?(revoked|consumed)/i
    .test(err?.message || '');
}

async function getAuthenticatedClient(tenantId) {
  const tokenRow = getToken(tenantId);
  if (!tokenRow) throw new Error(`No token found for tenant ${tenantId}`);

  const xero = createXeroClient();

  // initialize() must be called before any token operations in xero-node v4
  await xero.initialize();

  const tokenSet = {
    access_token: tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expires_at: Math.floor(new Date(tokenRow.expires_at).getTime() / 1000),
    token_type: 'Bearer',
  };

  xero.setTokenSet(tokenSet);

  // Refresh if expired (or within 60s of expiry)
  const expiresAt = new Date(tokenRow.expires_at).getTime();
  if (Date.now() >= expiresAt - 60000) {
    try {
      const newTokenSet = await xero.refreshToken();
      const expiresAtDate = newTokenSet.expires_at
        ? new Date(newTokenSet.expires_at * 1000).toISOString()
        : new Date(Date.now() + 1800000).toISOString();
      // Rotate the token for the whole connection, not just this tenant — see
      // upsertTokenForConnection. Passing the token we just consumed is what identifies the
      // sibling tenants that would otherwise be stranded on it.
      const propagated = upsertTokenForConnection(tokenRow.refresh_token, {
        xero_tenant_id: tenantId,
        access_token: newTokenSet.access_token,
        refresh_token: newTokenSet.refresh_token,
        expires_at: expiresAtDate,
      });
      if (propagated > 1) {
        console.log(`Refreshed Xero token shared by ${propagated} tenants on this connection`);
      }
      xero.setTokenSet(newTokenSet);
    } catch (err) {
      if (isAuthorisationFailure(err)) {
        // The authorisation itself is gone, which kills every tenant on this connection.
        const affected = markConnectionDisconnected(tokenRow.refresh_token, tenantId);
        const names = getTenantsSharingRefreshToken(tokenRow.refresh_token)
          .map(row => row.name).filter(Boolean);
        const alsoAffected = affected > 1 && names.length
          ? ` This authorisation covers ${names.length} organisations (${names.join(', ')}); all need reconnecting.`
          : '';
        throw new Error(
          `Xero authorisation for tenant ${tenantId} is no longer valid (${err.message}). ` +
          `Reconnect this organisation from the dashboard.${alsoAffected}`
        );
      }
      // Not an auth problem — a network blip or a 5xx. Leave connection_status alone and preserve
      // the original error shape so apiCall's transient retry can still see it.
      const wrapped = new Error(`Token refresh failed for tenant ${tenantId}: ${err.message}`);
      wrapped.code = err.code;
      wrapped.response = err.response;
      throw wrapped;
    }
  }

  return xero;
}

const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

// Long syncs make dozens of sequential paginated calls — a single dropped connection or
// momentary 5xx late in that chain (e.g. mid-way through bank_balance) otherwise aborts the
// whole check for the cycle. Retry those the same way as a 429, just with a shorter backoff.
function isTransientError(err) {
  if (err.response && [429, 500, 502, 503, 504].includes(err.response.statusCode)) return true;
  if (err.code && TRANSIENT_NETWORK_CODES.has(err.code)) return true;
  return false;
}

async function apiCall(tenantId, fn, retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const xero = await getAuthenticatedClient(tenantId);
      return await fn(xero, tenantId);
    } catch (err) {
      if (isTransientError(err)) {
        const isRateLimit = err.response && err.response.statusCode === 429;
        const delay = isRateLimit ? Math.min(Math.pow(2, attempt) * 2500, 60000) : Math.min(Math.pow(2, attempt) * 1000, 15000);
        const reason = isRateLimit ? 'Rate limited' : `Transient error (${err.code || err.response?.statusCode})`;
        console.log(`${reason} (attempt ${attempt}/${retries}), waiting ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

async function getAllPages(xero, tenantId, fetchFn) {
  let page = 1;
  const allItems = [];
  while (true) {
    const items = await fetchFn(xero, tenantId, page);
    if (!items || items.length === 0) break;
    allItems.push(...items);
    if (items.length < 100) break;
    page++;
  }
  return allItems;
}

module.exports = { createXeroClient, getAuthenticatedClient, apiCall, getAllPages };
