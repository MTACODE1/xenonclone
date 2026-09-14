const express = require('express');
const router = express.Router();
const { createXeroClient } = require('../services/xeroClient');
const {
  upsertToken, upsertOrganisation, markOrganisationDisconnected, deleteToken, getToken,
  getOrganisationByTenantId, toggleStaffOrgAccess,
} = require('../db/queries');
const { isStaffManager } = require('../services/staffPermissions');
const crypto = require('crypto');

router.get('/connect', async (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const xero = createXeroClient(state);
    await xero.initialize();
    const url = await xero.buildConsentUrl();
    res.redirect(url);
  } catch (err) {
    console.error('Auth connect error:', err.message);
    res.status(500).send('Failed to initiate OAuth: ' + err.message);
  }
});

router.get('/callback', async (req, res) => {
  try {
    const xero = createXeroClient(req.session.oauthState);
    await xero.initialize();

    // Build full callback URL — xero-node needs the complete URL including host
    const fullCallbackUrl = `${process.env.XERO_REDIRECT_URI}${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
    // The query string carries Xero's one-time authorisation `code` and `state` — real secrets,
    // even though short-lived and single-use. Log only that the callback was reached, never the
    // query string itself.
    console.log('[OAuth callback] received, redirect URI:', process.env.XERO_REDIRECT_URI);

    const tokenSet = await xero.apiCallback(fullCallbackUrl);
    delete req.session.oauthState;
    await xero.updateTenants();
    const tenants = xero.tenants;

    console.log('[OAuth callback] Tenants received:', tenants.length);

    for (const tenant of tenants) {
      const expiresAt = tokenSet.expires_at
        ? new Date(tokenSet.expires_at * 1000).toISOString()
        : new Date(Date.now() + 1800000).toISOString();

      await upsertToken({
        xero_tenant_id: tenant.tenantId,
        access_token: tokenSet.access_token,
        refresh_token: tokenSet.refresh_token,
        expires_at: expiresAt,
      });

      await upsertOrganisation({
        xero_tenant_id: tenant.tenantId,
        name: tenant.tenantName,
        client_ref: null,
        tag: null,
        connection_status: 'connected',
        last_synced_at: null,
      });

      // A staff-tier (non-admin) account has no client access until an admin grants it via the
      // "+" popover on the Client List — without this, whoever just connected a brand-new client
      // would immediately be locked out of the very client they added ("You do not have access
      // to this client"), since a fresh org starts with zero access grants for anyone. Admins/
      // super_admins don't need this (they see every client regardless), so only grant it for
      // staff-tier connectors.
      if (!isStaffManager(req.session.staffRole) && req.session.staffId) {
        const org = await getOrganisationByTenantId(tenant.tenantId);
        if (org) await toggleStaffOrgAccess(req.session.staffId, org.id, true);
      }
    }

    res.redirect('/');
  } catch (err) {
    console.error('Auth callback error:', err.message);
    const msg = err?.message || err?.error_description || JSON.stringify(err) || 'Unknown error';
    res.status(500).send('OAuth callback failed: ' + msg);
  }
});

router.post('/disconnect/:tenantId', express.urlencoded({ extended: true }), async (req, res) => {
  const { tenantId } = req.params;
  if (!req.session.csrfToken || req.body.csrf_token !== req.session.csrfToken) {
    return res.status(403).send('Invalid form token');
  }
  try {
    const xero = createXeroClient();
    const tokenRow = await getToken(tenantId);
    if (tokenRow) {
      xero.setTokenSet({ access_token: tokenRow.access_token, refresh_token: tokenRow.refresh_token });
      try { await xero.revokeToken(); } catch (e) { /* ignore */ }
    }
    await markOrganisationDisconnected(tenantId);
    await deleteToken(tenantId);
    res.redirect('/');
  } catch (err) {
    console.error('Disconnect error:', err.message);
    await markOrganisationDisconnected(tenantId);
    res.redirect('/');
  }
});

module.exports = router;
