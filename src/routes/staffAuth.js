const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { getStaffByMtakpiName, touchStaffLastLogin } = require('../db/queries');
const { verifyMtakpiLogin } = require('../services/mtakpiAuth');

router.get('/', (req, res) => {
  if (req.session.staffId) return res.redirect('/');
  res.render('login', { error: null });
});

// Single sign-on handoff from MTAKPI: a staff member already logged into MTAKPI clicks
// "Akrio Verify" there, which mints a ~45s signed token and opens this URL. We verify it
// against AKRIO_SSO_SECRET (deliberately NOT the same secret MTAKPI uses for its own JWT
// sessions, so this token can never double as one), then log the matching local staff
// record in — same session shape as a normal password login.
router.get('/sso', (req, res) => {
  const token = req.query.token;
  const secret = process.env.AKRIO_SSO_SECRET;
  if (!token || !secret) {
    return res.render('login', { error: 'Single sign-on is not configured.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (error) {
    return res.render('login', { error: 'Your sign-in link expired — please open Akrio Verify again from MTAKPI.' });
  }
  if (payload.purpose !== 'akrio_sso' || !payload.staff_name) {
    return res.render('login', { error: 'Invalid sign-in link.' });
  }

  const staff = getStaffByMtakpiName(payload.staff_name);
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
