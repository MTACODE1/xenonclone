const {
  getFreeAgentToken, upsertFreeAgentToken, markOrganisationDisconnectedByFreeAgentCompany,
} = require('../db/queries');

// Stage 1 only supports the simpler "connect as a single company" flow (FREEAGENT_AS_CLIENT_ID/
// SECRET) — mirrors exactly how Xero connect works today (one OAuth grant -> one new Akrio
// client), not FreeAgent's separate "Practice Dashboard, pick from many companies" flow. See
// FREEAGENT_CONNECTION.md for why that flow exists and what it would take to add later.
function freeAgentHost() {
  return process.env.FREEAGENT_ENVIRONMENT === 'production'
    ? 'https://api.freeagent.com'
    : 'https://api.sandbox.freeagent.com';
}

function buildConsentUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.FREEAGENT_AS_CLIENT_ID,
    redirect_uri: process.env.FREEAGENT_REDIRECT_URI,
    state,
  });
  return `${freeAgentHost()}/v2/approve_app?${params}`;
}

async function exchangeCodeForToken(code) {
  const response = await fetch(`${freeAgentHost()}/v2/token_endpoint`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': process.env.FREEAGENT_USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.FREEAGENT_REDIRECT_URI,
      client_id: process.env.FREEAGENT_AS_CLIENT_ID,
      client_secret: process.env.FREEAGENT_AS_CLIENT_SECRET,
    }),
  });
  if (!response.ok) {
    throw new Error(`FreeAgent token exchange failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch(`${freeAgentHost()}/v2/token_endpoint`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': process.env.FREEAGENT_USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.FREEAGENT_AS_CLIENT_ID,
      client_secret: process.env.FREEAGENT_AS_CLIENT_SECRET,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    const err = new Error(`FreeAgent token refresh failed: ${response.status} ${body}`);
    err.isAuthFailure = response.status === 400 || response.status === 401;
    throw err;
  }
  return response.json();
}

// Fetches the company profile for a fresh token — used right after connect to identify which
// FreeAgent company this is (name, registration number, etc.), the equivalent of Xero's
// getOrganisations() call in the callback.
async function fetchCompanyProfile(accessToken) {
  const response = await fetch(`${freeAgentHost()}/v2/company`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': process.env.FREEAGENT_USER_AGENT,
      'X-Api-Version': process.env.FREEAGENT_API_VERSION,
    },
  });
  if (!response.ok) {
    throw new Error(`FreeAgent company lookup failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  return body.company;
}

async function getValidAccessToken(companyId) {
  const tokenRow = await getFreeAgentToken(companyId);
  if (!tokenRow) throw new Error(`No FreeAgent token found for company ${companyId}`);

  const expiresAt = new Date(tokenRow.expires_at).getTime();
  if (Date.now() < expiresAt - 60000) return tokenRow.access_token;

  try {
    const newTokenSet = await refreshAccessToken(tokenRow.refresh_token);
    const expiresAtDate = newTokenSet.expires_in
      ? new Date(Date.now() + newTokenSet.expires_in * 1000).toISOString()
      : new Date(Date.now() + 1800000).toISOString();
    await upsertFreeAgentToken({
      freeagent_company_id: companyId,
      access_token: newTokenSet.access_token,
      refresh_token: newTokenSet.refresh_token || tokenRow.refresh_token,
      expires_at: expiresAtDate,
    });
    return newTokenSet.access_token;
  } catch (err) {
    if (err.isAuthFailure) {
      await markOrganisationDisconnectedByFreeAgentCompany(companyId);
      throw new Error(
        `FreeAgent authorisation for company ${companyId} is no longer valid. ` +
        `Reconnect this organisation from the dashboard.`
      );
    }
    throw err;
  }
}

const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const API_CALL_TIMEOUT_MS = 45000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`FreeAgent API call timed out after ${ms}ms`), { code: 'ETIMEDOUT' }));
    }, ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

// Mirrors xeroClient.js's apiCall shape (bounded retries, backoff, honours Retry-After) so the
// two providers behave the same way under the same rate-limit/transient-error conditions.
async function apiCall(companyId, path, { params } = {}, retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const accessToken = await getValidAccessToken(companyId);
      const url = new URL(`${freeAgentHost()}${path}`);
      for (const [key, value] of Object.entries(params || {})) {
        if (value != null) url.searchParams.set(key, value);
      }
      const response = await withTimeout(fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': process.env.FREEAGENT_USER_AGENT,
          'X-Api-Version': process.env.FREEAGENT_API_VERSION,
        },
      }), API_CALL_TIMEOUT_MS);
      if (TRANSIENT_STATUS_CODES.has(response.status)) {
        const err = new Error(`FreeAgent API returned ${response.status}`);
        err.response = { statusCode: response.status, headers: Object.fromEntries(response.headers) };
        throw err;
      }
      if (!response.ok) {
        throw new Error(`FreeAgent API call failed: ${response.status} ${await response.text()}`);
      }
      return response.json();
    } catch (err) {
      const isTransient = err.code === 'ETIMEDOUT' ||
        (err.response && TRANSIENT_STATUS_CODES.has(err.response.statusCode));
      if (isTransient && attempt < retries) {
        const delay = Math.min(Math.pow(2, attempt) * 1000, 15000);
        console.log(`FreeAgent transient error (attempt ${attempt}/${retries}), waiting ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

module.exports = {
  buildConsentUrl, exchangeCodeForToken, fetchCompanyProfile, getValidAccessToken, apiCall,
};
