const express = require('express');
const router = express.Router();
const { createXeroClient } = require('../services/xeroClient');
const { upsertToken, upsertOrganisation, markOrganisationDisconnected, deleteToken, getToken } = require('../db/queries');
const crypto = require('crypto');

router.get('/connect', async (req, res) => {
  try {
    const xero = createXeroClient();
    await xero.initialize();
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const url = await xero.buildConsentUrl();
    res.redirect(url);
  } catch (err) {
    console.error('Auth connect error:', err);
    res.status(500).send('Failed to initiate OAuth: ' + err.message);
  }
});

router.get('/callback', async (req, res) => {
  try {
    const xero = createXeroClient();
    await xero.initialize();

    // Build full callback URL — xero-node needs the complete URL including host
    const fullCallbackUrl = `${process.env.XERO_REDIRECT_URI}${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
    console.log('[OAuth callback] URL:', fullCallbackUrl);

    const tokenSet = await xero.apiCallback(fullCallbackUrl);
    await xero.updateTenants();
    const tenants = xero.tenants;

    console.log('[OAuth callback] Tenants received:', tenants.length);

    for (const tenant of tenants) {
      const expiresAt = tokenSet.expires_at
        ? new Date(tokenSet.expires_at * 1000).toISOString()
        : new Date(Date.now() + 1800000).toISOString();

      upsertToken({
        xero_tenant_id: tenant.tenantId,
        access_token: tokenSet.access_token,
        refresh_token: tokenSet.refresh_token,
        expires_at: expiresAt,
      });

      upsertOrganisation({
        xero_tenant_id: tenant.tenantId,
        name: tenant.tenantName,
        client_ref: null,
        tag: null,
        connection_status: 'connected',
        last_synced_at: null,
      });
    }

    res.redirect('/');
  } catch (err) {
    console.error('Auth callback error:', err);
    const msg = err?.message || err?.error_description || JSON.stringify(err) || 'Unknown error';
    res.status(500).send('OAuth callback failed: ' + msg);
  }
});

router.get('/disconnect/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  try {
    const xero = createXeroClient();
    const tokenRow = getToken(tenantId);
    if (tokenRow) {
      xero.setTokenSet({ access_token: tokenRow.access_token, refresh_token: tokenRow.refresh_token });
      try { await xero.revokeToken(); } catch (e) { /* ignore */ }
    }
    markOrganisationDisconnected(tenantId);
    deleteToken(tenantId);
    res.redirect('/');
  } catch (err) {
    console.error('Disconnect error:', err);
    markOrganisationDisconnected(tenantId);
    res.redirect('/');
  }
});

module.exports = router;
