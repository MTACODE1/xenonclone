const { getOrganisationByTenantId, staffHasOrgAccess } = require('../db/queries');
const { isStaffManager } = require('../services/staffPermissions');

// Mounted once on the /client router (every one of its ~20 routes is keyed by :tenantId) —
// covers all of them without touching any individual route body.
function resolveOrgAccess(req, res, next) {
  const org = getOrganisationByTenantId(req.params.tenantId);
  if (!org) return res.status(404).send('Organisation not found');
  if (!isStaffManager(req.session.staffRole) && !staffHasOrgAccess(req.session.staffId, org.id)) {
    return res.status(403).send('You do not have access to this client');
  }
  next();
}

module.exports = { resolveOrgAccess };
