// "Bank screen readings": the Akrio Verify browser extension reads Xero's Bank accounts page in the
// staff member's own browser and the Verify page posts the figures here. Mounted behind the staff
// login. The organisation is always worked out on the server from the Xero short code, and the
// staff member must have access to that organisation.
const express = require('express');
const { isStaffManager } = require('../services/staffPermissions');
const { validateReading, readingFreshness, ReadingError, STALE_AFTER_DAYS } = require('../services/bankScreenReading');

function createBankScreenRouter(deps) {
  const {
    getAllOrganisations, getOrganisationById, getOrganisationByTenantId, staffHasOrgAccess,
    getShortCodeIndex, saveReading, getLatestReading,
  } = deps;
  const router = express.Router();

  const canAccess = async (req, orgId) =>
    isStaffManager(req.session.staffRole) || await staffHasOrgAccess(req.session.staffId, orgId);

  function verifyAjaxCsrf(req, res, next) {
    if (!req.session.csrfToken || req.get('x-csrf-token') !== req.session.csrfToken) {
      return res.status(403).json({ error: 'Invalid request token' });
    }
    next();
  }

  // The clients this staff member may update, with the Xero short code the extension needs.
  router.get('/organisations', async (req, res, next) => {
    try {
      const { byOrg } = await getShortCodeIndex();
      const organisations = [];
      for (const org of await getAllOrganisations()) {
        const shortCode = byOrg.get(org.id);
        if (!shortCode || !(await canAccess(req, org.id))) continue;
        organisations.push({ tenantId: org.xero_tenant_id, name: org.name, shortCode });
      }
      res.json({ organisations });
    } catch (error) { next(error); }
  });

  router.get('/latest/:tenantId', async (req, res, next) => {
    try {
      const org = await getOrganisationByTenantId(req.params.tenantId);
      if (!org) return res.status(404).json({ error: 'Organisation not found' });
      if (!(await canAccess(req, org.id))) return res.status(403).json({ error: 'You do not have access to this client' });
      const { byOrg } = await getShortCodeIndex();
      const reading = await getLatestReading(org.id);
      res.json({
        shortCode: byOrg.get(org.id) || null,
        staleAfterDays: STALE_AFTER_DAYS,
        reading: reading && { ...reading, freshness: readingFreshness(reading.readAt) },
      });
    } catch (error) { next(error); }
  });

  router.post('/readings', express.json({ limit: '200kb' }), verifyAjaxCsrf, async (req, res, next) => {
    try {
      let reading;
      try {
        reading = validateReading(req.body);
      } catch (error) {
        if (error instanceof ReadingError) return res.status(400).json({ error: error.message });
        throw error;
      }
      const { byCode } = await getShortCodeIndex();
      const orgId = byCode.get(reading.shortCode);
      const org = orgId == null ? null : await getOrganisationById(orgId);
      if (!org) return res.status(404).json({ error: 'No client in Akrio Verify matches this Xero organisation' });
      if (!(await canAccess(req, org.id))) return res.status(403).json({ error: 'You do not have access to this client' });
      // The page says which client it was updating; if Xero's short code points at a different client, refuse.
      if (req.body.tenantId != null && req.body.tenantId !== org.xero_tenant_id) {
        return res.status(409).json({ error: 'The Xero page read does not belong to this client' });
      }
      const batchId = await saveReading(org.id, reading, { id: req.session.staffId ?? null, name: req.session.staffName ?? null });
      res.json({ ok: true, batchId, name: org.name, accounts: reading.accounts.length });
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = { createBankScreenRouter };
