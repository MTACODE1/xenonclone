// "Bank screen readings" for Zoho Books clients: the Akrio Verify browser extension reads Zoho Books' Banking page
// in the staff member's own browser and the Verify page posts the figures here. Mounted behind the staff login at
// /api/bank-screen/zoho, next to the Xero routes, which it does not touch. Same protections as the Xero readings:
// the form token on every save, the staff member must have access to the client, and the client is always worked
// out on the server from Zoho's organisation id ("zoho-<id>"), never from anything else the page says.
const express = require('express');
const { isStaffManager } = require('../services/staffPermissions');
const { ReadingError } = require('../services/bankScreenReading');
const { validateZohoReading, presentZohoReading, STALE_AFTER_DAYS } = require('../services/zohoBankScreenReading');
const { DEFAULT_BOOKS_HOST } = require('../../extension/zoho-parser');
const { buildZohoBankComparison } = require('../services/zohoBankComparison');

const ZOHO_IDENTIFIER = /^zoho-(\d{5,20})$/;
// A Zoho Books client's Zoho organisation id, or null for any other client (a Xero client never qualifies).
function zohoOrgIdOf(org) {
  if (!org || org.xero_tenant_id) return null;
  const match = String(org.freeagent_company_id || '').match(ZOHO_IDENTIFIER);
  return match ? match[1] : null;
}

function createZohoBankScreenRouter(deps) {
  const {
    getAllOrganisations, getOrganisationByTenantId, staffHasOrgAccess,
    saveZohoReading, getLatestZohoReading, getZohoLastReadTimes, getZohoBooksHosts, getCachedEntitiesAsync,
  } = deps;
  const router = express.Router();

  const canAccess = async (req, orgId) =>
    isStaffManager(req.session.staffRole) || await staffHasOrgAccess(req.session.staffId, orgId);
  const hostFor = (hosts, zohoOrgId) => hosts.get(zohoOrgId) || DEFAULT_BOOKS_HOST;

  function verifyAjaxCsrf(req, res, next) {
    if (!req.session.csrfToken || req.get('x-csrf-token') !== req.session.csrfToken) {
      return res.status(403).json({ error: 'Invalid request token' });
    }
    next();
  }

  // The Zoho Books clients this staff member may update, with what the extension needs to open each one.
  router.get('/organisations', async (req, res, next) => {
    try {
      const hosts = await getZohoBooksHosts();
      const lastRead = await getZohoLastReadTimes();
      const organisations = [];
      for (const org of await getAllOrganisations()) {
        const zohoOrgId = zohoOrgIdOf(org);
        if (!zohoOrgId || !(await canAccess(req, org.id))) continue;
        const readAt = lastRead.get(org.id);
        organisations.push({
          tenantId: org.freeagent_company_id, name: org.name, orgId: zohoOrgId, booksHost: hostFor(hosts, zohoOrgId),
          lastReadAt: readAt ? readAt.toISOString() : null,
        });
      }
      res.json({ organisations });
    } catch (error) { next(error); }
  });

  router.get('/latest/:tenantId', async (req, res, next) => {
    try {
      const org = await getOrganisationByTenantId(req.params.tenantId);
      const zohoOrgId = zohoOrgIdOf(org);
      if (!zohoOrgId) return res.status(404).json({ error: 'Zoho Books client not found' });
      if (!(await canAccess(req, org.id))) return res.status(403).json({ error: 'You do not have access to this client' });
      const reading = await getLatestZohoReading(org.id);
      res.json({
        orgId: zohoOrgId,
        booksHost: hostFor(await getZohoBooksHosts(), zohoOrgId),
        staleAfterDays: STALE_AFTER_DAYS,
        reading: presentZohoReading(reading),
      });
    } catch (error) { next(error); }
  });

  // The screen reading beside what Zoho's API gave at the last sync, account by account (services/zohoBankComparison.js).
  // Read only: the cached 'account' rows and the 'organisation' read status, never a call to Zoho.
  router.get('/comparison/:tenantId', async (req, res, next) => {
    try {
      const org = await getOrganisationByTenantId(req.params.tenantId);
      const zohoOrgId = zohoOrgIdOf(org);
      if (!zohoOrgId) return res.status(404).json({ error: 'Zoho Books client not found' });
      if (!(await canAccess(req, org.id))) return res.status(403).json({ error: 'You do not have access to this client' });
      const [reading, accounts, statusRows] = await Promise.all([
        getLatestZohoReading(org.id), getCachedEntitiesAsync(org.id, 'account'), getCachedEntitiesAsync(org.id, 'organisation'),
      ]);
      const statusId = 'zoho-' + zohoOrgId;
      const readStatus = (statusRows || []).find(row => row && row.organisationID === statusId) || null;
      res.json({ orgId: zohoOrgId, comparison: buildZohoBankComparison({ reading, accounts, readStatus }) });
    } catch (error) { next(error); }
  });

  router.post('/readings', express.json({ limit: '200kb' }), verifyAjaxCsrf, async (req, res, next) => {
    try {
      let reading;
      try {
        reading = validateZohoReading(req.body);
      } catch (error) {
        if (error instanceof ReadingError) return res.status(400).json({ error: error.message });
        throw error;
      }
      const org = await getOrganisationByTenantId('zoho-' + reading.orgId);
      if (!zohoOrgIdOf(org)) return res.status(404).json({ error: 'No client in Akrio Verify matches this Zoho Books organisation' });
      if (!(await canAccess(req, org.id))) return res.status(403).json({ error: 'You do not have access to this client' });
      // The page says which client it was updating; if Zoho's organisation is a different client, refuse.
      if (req.body.tenantId != null && req.body.tenantId !== org.freeagent_company_id) {
        return res.status(409).json({ error: 'The Zoho Books page read does not belong to this client' });
      }
      const batchId = await saveZohoReading(org.id, reading, { id: req.session.staffId ?? null, name: req.session.staffName ?? null });
      // The Zoho Books bank checks (Bank Balance, Unprocessed Bank, Bank Statements Review) use the latest reading
      // when Zoho's API refuses banking, but they are worked out by the Zoho sync (ledgerChecks.js -> zohoChecks.js),
      // not here: re-running the whole sync from a save would hold the request for minutes. So the checks pick
      // the reading up at the client's next sync, and the answer says so for the card to tell the user.
      res.json({ ok: true, batchId, name: org.name, accounts: reading.accounts.length, checksUpdated: false, checksUpdateAt: 'next_sync' });
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = { createZohoBankScreenRouter, zohoOrgIdOf };
