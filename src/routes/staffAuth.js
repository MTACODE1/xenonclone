const express = require('express');
const router = express.Router();
const { getStaffByMtakpiName, touchStaffLastLogin } = require('../db/queries');
const { verifyMtakpiLogin } = require('../services/mtakpiAuth');

router.get('/', (req, res) => {
  if (req.session.staffId) return res.redirect('/');
  res.render('login', { error: null });
});

// No CSRF check here — there's no prior session to compare a token against before login, and
// this isn't a state-changing action against another user's data.
router.post('/', express.urlencoded({ extended: true }), async (req, res) => {
  const { staff_name, password } = req.body;

  let mtakpiResult;
  try {
    mtakpiResult = await verifyMtakpiLogin(staff_name, password);
  } catch (error) {
    console.error('[login] MTAKPI auth lookup failed:', error.message);
    return res.render('login', { error: 'Login is temporarily unavailable — please try again shortly.' });
  }
  if (!mtakpiResult.ok) {
    // Same generic message for not_found/bad_password (don't reveal which one, standard
    // practice) — 'disabled' gets its own message since it's actionable and not a credentials issue.
    const error = mtakpiResult.reason === 'disabled'
      ? 'Your MTAKPI account is disabled. Contact an admin.'
      : 'Invalid staff name or password';
    return res.render('login', { error });
  }

  const staff = getStaffByMtakpiName(mtakpiResult.mtakpiStaff.staff_name);
  if (!staff || !staff.is_active) {
    return res.render('login', {
      error: "You don't have Akrio Verify access yet. Ask an admin to add you on the Staff page.",
    });
  }

  req.session.staffId = staff.id;
  req.session.staffRole = staff.role;
  req.session.staffName = staff.name;
  touchStaffLastLogin(staff.id);
  res.redirect('/');
});

router.post('/logout', express.urlencoded({ extended: true }), (req, res) => {
  if (!req.session.csrfToken || req.body.csrf_token !== req.session.csrfToken) {
    return res.status(403).send('Invalid request token');
  }
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
