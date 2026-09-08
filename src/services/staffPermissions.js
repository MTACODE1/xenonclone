// Central permission rules for the three-tier staff role system (super_admin > admin > staff).
// Kept as pure functions (no DB access) so the exact rules are easy to read in one place and
// unit-test directly — every route that needs a permission decision should call these rather
// than re-deriving the logic inline.

const ROLE_RANK = { super_admin: 3, admin: 2, staff: 1 };

function isStaffManager(role) {
  return role === 'admin' || role === 'super_admin';
}

// Only super_admin may grant or revoke admin/super_admin — a regular admin can only ever
// create/edit accounts at the staff tier. Applies to both "what role can I assign" and
// "can I change this existing account's role at all".
function canAssignRole(actingRole, targetRole) {
  if (actingRole === 'super_admin') return true;
  if (actingRole === 'admin') return targetRole === 'staff';
  return false;
}

// Whether actingRole can deactivate/reactivate/delete/edit-access-for an account currently at
// targetRole. Same boundary as canAssignRole: admins only touch staff-tier accounts; super_admin
// can touch anyone (including other admins) but never needs to touch itself down — that's
// enforced separately (see staff.js route: a super_admin can't demote/deactivate their own row).
function canManageAccountAtRole(actingRole, targetRole) {
  if (actingRole === 'super_admin') return true;
  if (actingRole === 'admin') return targetRole === 'staff';
  return false;
}

function canAccessSettings(staff) {
  return isStaffManager(staff?.role) || !!staff?.can_manage_settings;
}

// Roles a given actor is allowed to pick from when creating or editing an account — drives
// which <option>s the role <select> should even offer.
function assignableRoles(actingRole) {
  if (actingRole === 'super_admin') return ['staff', 'admin', 'super_admin'];
  if (actingRole === 'admin') return ['staff'];
  return [];
}

module.exports = {
  ROLE_RANK, isStaffManager, canAssignRole, canManageAccountAtRole, canAccessSettings, assignableRoles,
};
