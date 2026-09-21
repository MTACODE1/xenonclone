const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const {
  buildConsentUrl, exchangeCodeForToken, fetchCompanyProfile,
} = require('../services/freeagentClient');
const {
  upsertFreeAgentToken, upsertFreeAgentOrganisation, getOrganisationByFreeAgentCompanyId,
  markOrganisationDisconnectedByFreeAgentCompany, deleteFreeAgentToken,
  toggleStaffOrgAccess,
} = require('../db/queries');
const { isStaffManager } = require('../services/staffPermissions');

// Stage 1: mirrors src/routes/auth.js's Xero flow exactly (one OAuth grant -> one new Akrio
// client) rather than FreeAgent's separate Practice Dashboard/company-picker flow — see
// FREEAGENT_CONNECTION.md for why that flow exists and the plan file for why it's deferred.

router.get('/connect', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.freeagentOauthState = state;
  res.redirect(buildConsentUrl(state));
});

router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.freeagentOauthState) {
      return res.status(400).send('Invalid or expired FreeAgent sign-in link. Please try connecting again.');
    }
    delete req.session.freeagentOauthState;

    const tokenSet = await exchangeCodeForToken(code);
    const expiresAt = tokenSet.expires_in
      ? new Date(Date.now() + tokenSet.expires_in * 1000).toISOString()
      : new Date(Date.now() + 1800000).toISOString();

    const company = await fetchCompanyProfile(tokenSet.access_token);
    // Unlike invoice/bill/contact URLs, FreeAgent's own /v2/company url has no trailing numeric id
    // (it's a fixed ".../company" endpoint per company) — idFromUrl's regex can't extract one from
    // it and falls back to returning the whole URL string, which then breaks Express route params
    // (:tenantId/:companyId) wherever it's used since it contains "/" characters. The company
    // object's own `id` field is the real numeric identifier and must be used here instead.
    const companyId = String(company.id);

    await upsertFreeAgentToken({
      freeagent_company_id: companyId,
      access_token: tokenSet.access_token,
      refresh_token: tokenSet.refresh_token,
      expires_at: expiresAt,
    });

    await upsertFreeAgentOrganisation({
      freeagent_company_id: companyId,
      name: company.name,
      client_ref: null,
      tag: null,
      connection_status: 'connected',
      last_synced_at: null,
    });

    // Same reasoning as the Xero callback (src/routes/auth.js): a staff-tier account connecting a
    // brand-new client would otherwise be immediately locked out of it (zero access grants exist
    // for a fresh org). Admins/super_admins don't need this — they see every client regardless.
    if (!isStaffManager(req.session.staffRole) && req.session.staffId) {
      const org = await getOrganisationByFreeAgentCompanyId(companyId);
      if (org) await toggleStaffOrgAccess(req.session.staffId, org.id, true);
    }

    res.redirect('/');
  } catch (err) {
    console.error('FreeAgent callback error:', err.message);
    res.status(500).send('FreeAgent connection failed: ' + err.message);
  }
});

router.post('/disconnect/:companyId', express.urlencoded({ extended: true }), async (req, res) => {
  const { companyId } = req.params;
  if (!req.session.csrfToken || req.body.csrf_token !== req.session.csrfToken) {
    return res.status(403).send('Invalid form token');
  }
  try {
    await markOrganisationDisconnectedByFreeAgentCompany(companyId);
    await deleteFreeAgentToken(companyId);
    res.redirect('/');
  } catch (err) {
    console.error('FreeAgent disconnect error:', err.message);
    res.redirect('/');
  }
});

module.exports = router;
