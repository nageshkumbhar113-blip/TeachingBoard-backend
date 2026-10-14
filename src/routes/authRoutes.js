const express = require("express");

const { login, me } = require("../controllers/authController");
const { requireAuth } = require("../middleware/auth");
const { createRateLimiter } = require("../middleware/rateLimiter");

const router = express.Router();

// Login rate limits. Only POST /login is limited — GET /me is the student
// app's routine profile refresh (every sync), and it used to share the same
// 30-per-15-min per-IP budget, so a few students on one school Wi-Fi (or one
// mobile-carrier NAT IP) locked each other out of login entirely.
// Students/teachers/parents: a generous per-IP budget (a whole class can log
// in from one network) plus a tight per-account budget, which is what
// actually stops PIN guessing. Admin (one account, PIN only) keeps the
// original strict per-IP limit and no per-account limit, so nobody can lock
// the admin out by spamming wrong PINs.
const WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MESSAGE = 'Too many login attempts — please try again later';
const _role = req => String(req.body?.role || '').trim().toLowerCase();
const _accountCode = req => String(
  req.body?.student_code || req.body?.teacher_code || req.body?.parent_code || ''
).trim().toUpperCase();

const adminIpLimiter = createRateLimiter({
  windowMs: WINDOW_MS, max: 30, message: LOGIN_MESSAGE,
  skip: req => _role(req) !== 'admin',
});
const userIpLimiter = createRateLimiter({
  windowMs: WINDOW_MS, max: 150, message: LOGIN_MESSAGE,
  skip: req => _role(req) === 'admin',
});
const accountLimiter = createRateLimiter({
  windowMs: WINDOW_MS, max: 20, message: LOGIN_MESSAGE,
  skip: req => _role(req) === 'admin',
  keyFn: req => (_accountCode(req) ? `${_role(req)}:${_accountCode(req)}` : ''),
});

router.post("/login", adminIpLimiter, userIpLimiter, accountLimiter, login);
router.get("/me", requireAuth, me);

module.exports = router;
