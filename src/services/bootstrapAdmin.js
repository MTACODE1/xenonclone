const { getAllStaff, createStaff } = require('../db/queries');

// Runs once at boot. If no staff accounts exist yet, creates one super_admin linked to
// ADMIN_MTAKPI_STAFF_NAME so the person deploying this isn't locked out the moment login is
// turned on — no local password to set, since authentication happens against MTAKPI's own
// UserDataMatch table (see src/services/mtakpiAuth.js). super_admin (not admin) because this is
// the very first account and someone needs the ability to grant admin/super_admin to others at
// all (see src/services/staffPermissions.js — only super_admin can do that). Deliberately does
// NOT hard-fail if the env var is unset in dev — it just warns, mirroring how SESSION_SECRET is
// required in production but falls back with a warning in dev.
function bootstrapAdmin() {
  if (getAllStaff().length > 0) return;

  if (!process.env.ADMIN_MTAKPI_STAFF_NAME) {
    console.warn(
      '[bootstrap] No staff accounts exist and ADMIN_MTAKPI_STAFF_NAME is unset — ' +
      'no one will be able to log in. Set it in .env (to a real MTAKPI staff_name) and restart.'
    );
    return;
  }

  createStaff({
    mtakpi_staff_name: process.env.ADMIN_MTAKPI_STAFF_NAME.trim(),
    name: process.env.ADMIN_MTAKPI_STAFF_NAME.trim(), initials: 'AD', role: 'super_admin',
  });
  console.log(`[bootstrap] Created initial super_admin account for MTAKPI staff_name: ${process.env.ADMIN_MTAKPI_STAFF_NAME}`);
}

module.exports = { bootstrapAdmin };
