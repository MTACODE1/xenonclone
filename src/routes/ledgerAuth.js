// Connect, choose and disconnect for QuickBooks and Zoho Books clients (one router per ledger,
// mounted at /auth/quickbooks and /auth/zoho). Same shape as the FreeAgent routes: one staff
// member signs in to the ledger, each company they pick becomes a client in Verify.
//
// QuickBooks: one sign-in = one company (Intuit sends its realmId back), created straight away.
// Zoho Books: one sign-in can reach many organisations, so the staff member picks which ones.
const express = require('express');
const crypto = require('crypto');
const ledgers = require('../services/ledgers');
const { saveLedgerToken, deleteLedgerToken } = require('../db/ledgerTokens');
const {
  upsertFreeAgentOrganisation, getOrganisationByFreeAgentCompanyId,
  markOrganisationDisconnectedByFreeAgentCompany, toggleStaffOrgAccess, staffHasOrgAccess,
} = require('../db/queries');
const { isStaffManager } = require('../services/staffPermissions');

const escapeHtml = value => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function createLedgerAuthRouter(key, { providerModule = null } = {}) {
  const router = express.Router();
  const label = ledgers.ledgerLabel(key);
  const provider = () => providerModule || ledgers.provider(key);
  const stateKey = `${key}OauthState`;
  const pendingKey = `${key}PendingCompanies`;

  async function connectCompany(req, company) {
    const identifier = ledgers.identifierFor(key, company.externalId);
    await saveLedgerToken(key, company.externalId, company.token);
    await upsertFreeAgentOrganisation({
      freeagent_company_id: identifier, name: company.name || `${label} company ${company.externalId}`,
      client_ref: null, tag: null, connection_status: 'connected', last_synced_at: null,
    });
    // As for Xero and FreeAgent: a staff-tier user who connects a new client must be able to see it.
    if (!isStaffManager(req.session.staffRole) && req.session.staffId) {
      const org = await getOrganisationByFreeAgentCompanyId(identifier);
      if (org) await toggleStaffOrgAccess(req.session.staffId, org.id, true);
    }
  }

  // Zoho keeps only the 20 newest refresh tokens per user and app, and every sign-in makes a new one.
  // So each sign-in also moves every organisation it can see that is already a client onto the new
  // token; otherwise the clients added by the earliest sign-ins would stop syncing after 20 more.
  async function refreshKnownCompanies(companies) {
    for (const company of companies) {
      const org = await getOrganisationByFreeAgentCompanyId(ledgers.identifierFor(key, company.externalId));
      if (org) await saveLedgerToken(key, company.externalId, company.token);
    }
  }

  function pendingOrNull(req) {
    const pending = req.session[pendingKey];
    if (pending && Date.now() - pending.at <= 15 * 60 * 1000) return pending;
    delete req.session[pendingKey]; // never leave an expired sign-in's token in the session
    return null;
  }

  router.get('/connect', (req, res) => {
    if (!provider().isConfigured()) {
      return res.status(503).send(`${escapeHtml(label)} is not set up in Akrio Verify yet: its app keys have not been added. Please ask the developer.`);
    }
    const state = crypto.randomBytes(16).toString('hex');
    req.session[stateKey] = state;
    res.redirect(provider().buildConsentUrl(state));
  });

  router.get('/callback', async (req, res) => {
    try {
      const { state, error } = req.query;
      if (error) return res.status(400).send(`${escapeHtml(label)} sign-in was cancelled or refused (${escapeHtml(error)}).`);
      if (!state || !req.session[stateKey] || state !== req.session[stateKey]) {
        return res.status(400).send(`Invalid or expired ${escapeHtml(label)} sign-in link. Please try connecting again.`);
      }
      delete req.session[stateKey];
      const companies = await provider().completeConnection(req.query);
      if (!companies.length) return res.status(400).send(`No ${escapeHtml(label)} company was found for this sign-in.`);
      await refreshKnownCompanies(companies);
      if (companies.length === 1) {
        await connectCompany(req, companies[0]);
        return res.redirect('/');
      }
      // Several organisations: keep them on the server-side session until the staff member picks.
      req.session[pendingKey] = { at: Date.now(), companies };
      return res.redirect(`${res.locals.basePath || ''}/auth/${key}/choose`);
    } catch (err) {
      console.error(`${label} callback error:`, err.message);
      res.status(500).send(`${escapeHtml(label)} connection failed: ${escapeHtml(err.message)}`);
    }
  });

  router.get('/choose', (req, res) => {
    const pending = pendingOrNull(req);
    if (!pending) {
      return res.status(400).send(`The ${escapeHtml(label)} sign-in has expired. Please connect again.`);
    }
    const rows = pending.companies.map(c => `
      <label style="display:block;padding:8px 0;border-bottom:1px solid #eef2f6;">
        <input type="checkbox" name="externalId" value="${escapeHtml(c.externalId)}"> ${escapeHtml(c.name)}
        <span style="color:#7C8FAC;font-size:12px;">(${escapeHtml(c.externalId)})</span>
      </label>`).join('');
    res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Choose ${escapeHtml(label)} organisations</title></head>
      <body style="font-family:'Plus Jakarta Sans',Arial,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#2A3547;">
      <h2>Choose the ${escapeHtml(label)} organisations to add</h2>
      <p style="color:#5A6A85;">This sign-in can see ${pending.companies.length} organisations. Tick the clients to add to Akrio Verify.</p>
      <form method="POST" action="${escapeHtml(res.locals.basePath || '')}/auth/${key}/choose">
        <input type="hidden" name="csrf_token" value="${escapeHtml(req.session.csrfToken || '')}">
        ${rows}
        <p><button type="submit" style="margin-top:16px;padding:10px 18px;background:#5D87FF;color:#fff;border:0;border-radius:6px;">Add selected clients</button>
        <button type="submit" name="cancel" value="1" style="margin-left:12px;padding:10px 18px;background:#fff;border:1px solid #c9d3e0;border-radius:6px;">Cancel</button></p>
      </form></body></html>`);
  });

  router.post('/choose', express.urlencoded({ extended: true }), async (req, res) => {
    if (!req.session.csrfToken || req.body.csrf_token !== req.session.csrfToken) {
      return res.status(403).send('Invalid form token');
    }
    const pending = pendingOrNull(req);
    if (!pending) {
      return res.status(400).send(`The ${escapeHtml(label)} sign-in has expired. Please connect again.`);
    }
    if (req.body.cancel) {
      delete req.session[pendingKey];
      return res.redirect('/');
    }
    const chosen = new Set([].concat(req.body.externalId || []).map(String));
    try {
      for (const company of pending.companies.filter(c => chosen.has(String(c.externalId)))) {
        await connectCompany(req, company);
      }
      delete req.session[pendingKey];
      res.redirect('/');
    } catch (err) {
      delete req.session[pendingKey];
      console.error(`${label} connect error:`, err.message);
      res.status(500).send(`${escapeHtml(label)} connection failed: ${escapeHtml(err.message)}`);
    }
  });

  router.post('/disconnect/:externalId', express.urlencoded({ extended: true }), async (req, res) => {
    if (!req.session.csrfToken || req.body.csrf_token !== req.session.csrfToken) {
      return res.status(403).send('Invalid form token');
    }
    try {
      const { externalId } = req.params;
      const identifier = ledgers.identifierFor(key, externalId);
      // Only someone who can see the client may disconnect it (managers see every client).
      const org = await getOrganisationByFreeAgentCompanyId(identifier);
      if (!org) return res.redirect('/');
      if (!isStaffManager(req.session.staffRole) && !(await staffHasOrgAccess(req.session.staffId, org.id))) {
        return res.status(403).send('You do not have access to this client.');
      }
      await markOrganisationDisconnectedByFreeAgentCompany(identifier);
      await deleteLedgerToken(key, externalId);
    } catch (err) {
      console.error(`${label} disconnect error:`, err.message);
    }
    res.redirect('/');
  });

  return router;
}

module.exports = { createLedgerAuthRouter };
