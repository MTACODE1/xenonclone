const express = require('express');
const router = express.Router();
const {
  getAllStaff, getStaffById, createStaff, createStaffBulk, deactivateStaff, reactivateStaff,
  getOrgIdsForStaff, replaceStaffOrgAccess, getAllOrganisations,
  updateStaffRole, updateStaffInitials, setStaffCanManageSettings, deleteStaff,
} = require('../db/queries');
const { findMtakpiStaffByName, listMtakpiStaffNames } = require('../services/mtakpiAuth');
const { canAssignRole, canManageAccountAtRole, assignableRoles } = require('../services/staffPermissions');

function verifyCsrf(req, res, next) {
  const supplied = req.body?.csrf_token || req.get('x-csrf-token');
  if (!req.session.csrfToken || supplied !== req.session.csrfToken) {
    return res.status(403).send('Invalid form token');
  }
  next();
}

function guessInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return (parts[0] || '').slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Loads the target account and checks the acting user is allowed to manage an account at its
// current role (admins: staff-tier only; super_admin: anyone). Also blocks acting on your own
// account for the destructive actions (deactivate/delete) so nobody locks themselves out.
async function loadManageableTarget(req, res, { blockSelf } = {}) {
  const target = await getStaffById(req.params.id);
  if (!target) {
    res.status(404).send('Staff member not found');
    return null;
  }
  if (blockSelf && target.id === req.session.staffId) {
    res.status(400).send('You cannot do this to your own account');
    return null;
  }
  if (!canManageAccountAtRole(req.session.staffRole, target.role)) {
    res.status(403).send('You do not have permission to manage this account');
    return null;
  }
  return target;
}

// Mounted at /staff, admin/super_admin only (see app.js).
// The MTAKPI-picker/import UI was removed from staffList.ejs (all real staff were already
// imported in one pass) — the /staff/import and /staff POST routes below still exist and work
// if bulk-adding is needed again later, they're just not linked from the page anymore.
router.get('/', async (req, res, next) => {
  try {
    const myRole = req.session.staffRole;
    const allStaff = await getAllStaff();
    const staff = await Promise.all(allStaff.map(async s => ({
      ...s,
      orgCount: (await getOrgIdsForStaff(s.id)).length,
      canManage: s.id !== req.session.staffId && canManageAccountAtRole(myRole, s.role),
      canChangeRole: canAssignRole(myRole, s.role) && s.id !== req.session.staffId,
    })));
    res.render('staffList', {
      staff, currentPage: 'staff',
      myId: req.session.staffId,
      myRole: req.session.staffRole,
      assignableRoles: assignableRoles(req.session.staffRole),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', express.urlencoded({ extended: true }), verifyCsrf, async (req, res) => {
  const { mtakpi_staff_name, name, initials, role } = req.body;
  if (!mtakpi_staff_name || !name || !initials || !assignableRoles(req.session.staffRole).includes(role)) {
    return res.status(400).send('Missing or invalid field');
  }
  // Catches a typo'd staff_name immediately rather than silently creating an account that can
  // never log in — real verification still happens against MTAKPI at login time either way.
  try {
    const mtakpiMatch = await findMtakpiStaffByName(mtakpi_staff_name);
    if (!mtakpiMatch) {
      return res.status(400).send(`No MTAKPI staff member named "${mtakpi_staff_name}" was found`);
    }
  } catch (error) {
    console.error('[staff] MTAKPI lookup failed during staff creation:', error.message);
    return res.status(503).send('Could not verify against MTAKPI right now — try again shortly.');
  }
  try {
    await createStaff({
      mtakpi_staff_name: mtakpi_staff_name.trim(),
      name: name.trim(), initials: initials.trim().toUpperCase().slice(0, 3), role,
    });
  } catch (error) {
    return res.status(400).send(/Duplicate entry/.test(error.message) ? 'That MTAKPI staff name is already linked to an account' : error.message);
  }
  res.redirect('/staff');
});

// Bulk import from the picker table on the Staff page — one submit creates every checked
// MTAKPI name at once instead of adding people one at a time via the single form above. Always
// staff-tier (the picker offers no role choice), consistent with a regular admin's own ceiling —
// a super_admin who wants to import someone straight in as admin can promote them afterward.
router.post('/import', express.urlencoded({ extended: true }), verifyCsrf, async (req, res, next) => {
  const selected = [].concat(req.body.selected_names || []);
  const initialsMap = req.body.initials_map || {};
  if (!selected.length) return res.redirect('/staff');

  const entries = selected
    .map(mtakpiName => ({
      mtakpi_staff_name: mtakpiName,
      name: mtakpiName,
      initials: String(initialsMap[mtakpiName] || '').trim().toUpperCase().slice(0, 3),
      role: 'staff',
    }))
    .filter(entry => entry.initials);

  try {
    const created = await createStaffBulk(entries);
    res.redirect(`/staff?imported=${created}`);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/deactivate', express.urlencoded({ extended: true }), verifyCsrf, async (req, res, next) => {
  try {
    const target = await loadManageableTarget(req, res, { blockSelf: true });
    if (!target) return;
    await deactivateStaff(target.id);
    res.redirect('/staff');
  } catch (error) {
    next(error);
  }
});

router.post('/:id/reactivate', express.urlencoded({ extended: true }), verifyCsrf, async (req, res, next) => {
  try {
    const target = await loadManageableTarget(req, res);
    if (!target) return;
    await reactivateStaff(target.id);
    res.redirect('/staff');
  } catch (error) {
    next(error);
  }
});

// Hard delete — distinct from deactivate. Same permission boundary as everything else here
// (admins: staff-tier only; super_admin: anyone but themselves).
router.post('/:id/delete', express.urlencoded({ extended: true }), verifyCsrf, async (req, res, next) => {
  try {
    const target = await loadManageableTarget(req, res, { blockSelf: true });
    if (!target) return;
    await deleteStaff(target.id);
    res.redirect('/staff');
  } catch (error) {
    next(error);
  }
});

// Role changes are the one action gated by canAssignRole rather than canManageAccountAtRole —
// an admin can never touch this route successfully (assignableRoles for 'admin' is just
// ['staff'], and canAssignRole blocks anything else), only super_admin can actually promote or
// demote someone to/from admin or super_admin.
router.post('/:id/role', express.urlencoded({ extended: true }), verifyCsrf, async (req, res, next) => {
  try {
    const target = await getStaffById(req.params.id);
    if (!target) return res.status(404).send('Staff member not found');
    const { role } = req.body;
    if (!canAssignRole(req.session.staffRole, role) || !canAssignRole(req.session.staffRole, target.role)) {
      return res.status(403).send('You do not have permission to change this account\'s role');
    }
    if (target.id === req.session.staffId && role !== target.role) {
      return res.status(400).send('You cannot change your own role');
    }
    await updateStaffRole(target.id, role);
    res.redirect('/staff');
  } catch (error) {
    next(error);
  }
});

router.post('/:id/initials', express.urlencoded({ extended: true }), verifyCsrf, async (req, res, next) => {
  try {
    const target = await loadManageableTarget(req, res);
    if (!target) return;
    const initials = String(req.body.initials || '').trim().toUpperCase().slice(0, 3);
    if (!initials) return res.status(400).send('Initials cannot be empty');
    await updateStaffInitials(target.id, initials);
    res.redirect('/staff');
  } catch (error) {
    next(error);
  }
});

// Grants/revokes Settings access independently of role — any admin/super_admin can toggle this
// for a staff-tier account they manage (a no-op in practice for admin/super_admin targets, who
// already have Settings access via their role regardless of this flag).
router.post('/:id/settings-access', express.urlencoded({ extended: true }), verifyCsrf, async (req, res, next) => {
  try {
    const target = await loadManageableTarget(req, res);
    if (!target) return;
    await setStaffCanManageSettings(target.id, req.body.can_manage_settings === '1');
    res.redirect('/staff');
  } catch (error) {
    next(error);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const staff = await getStaffById(req.params.id);
    if (!staff) return res.status(404).send('Staff member not found');
    if (!canManageAccountAtRole(req.session.staffRole, staff.role)) {
      return res.status(403).send('You do not have permission to view this account');
    }
    const assignedIds = new Set(await getOrgIdsForStaff(staff.id));
    const orgs = (await getAllOrganisations()).map(org => ({ ...org, assigned: assignedIds.has(org.id) }));
    res.render('staffEdit', { staff, orgs, currentPage: 'staff' });
  } catch (error) {
    next(error);
  }
});

// Replaces this staff member's ENTIRE org-access set in one submit — the primary editing
// surface. A checked checkbox's value is its org id; unchecked orgs are simply absent from the
// submitted array, so this "replace with whatever came through" approach handles adds/removes
// in one request without needing separate add/remove endpoints for this surface.
router.post('/:id/access', express.urlencoded({ extended: true }), verifyCsrf, async (req, res, next) => {
  try {
    const target = await loadManageableTarget(req, res);
    if (!target) return;
    const orgIds = [].concat(req.body.org_ids || []).map(Number).filter(Number.isFinite);
    await replaceStaffOrgAccess(target.id, orgIds);
    res.redirect(`/staff/${target.id}/edit`);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
