const { isStaffManager, canAccessSettings } = require('../services/staffPermissions');
const { getStaffById } = require('../db/queries');

function requireStaffLogin(req, res, next) {
  if (req.session.staffId) return next();
  return res.redirect('/login');
}

// Staff-management pages (the Staff list, per-account edit/access) — admin or super_admin only.
// Staff-tier accounts must never see this even by URL guessing.
function requireStaffManager(req, res, next) {
  if (isStaffManager(req.session.staffRole)) return next();
  return res.status(403).send('Admin access required');
}

// Only super_admin may reach role-assignment actions (making/removing an admin or super_admin).
function requireSuperAdmin(req, res, next) {
  if (req.session.staffRole === 'super_admin') return next();
  return res.status(403).send('Super Admin access required');
}

// Settings access is admin/super_admin by default, OR a staff-tier account with the separate
// can_manage_settings grant — fetched fresh (not from the session) so a permission change takes
// effect immediately without waiting for the person to log out and back in.
function requireSettingsAccess(req, res, next) {
  if (isStaffManager(req.session.staffRole)) return next();
  const staff = getStaffById(req.session.staffId);
  if (canAccessSettings(staff)) return next();
  return res.status(403).send('You do not have access to Settings');
}

module.exports = { requireStaffLogin, requireStaffManager, requireSuperAdmin, requireSettingsAccess };
