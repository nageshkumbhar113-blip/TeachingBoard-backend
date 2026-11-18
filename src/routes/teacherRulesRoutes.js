// 📜 Teacher rules (utils/teacherRules.js) — read by nkseduorbit.in/teacher-rules and the admin PDF,
// accepted by the teacher with their own code + PIN (no app update needed).
const express = require('express');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { createRateLimiter } = require('../middleware/rateLimiter');
const { invalidateUserCache } = require('../middleware/auth');
const { RULES, RULES_VERSION } = require('../utils/teacherRules');

const router = express.Router();

// A PIN is guessable in 10,000 tries: 10 attempts per address per 15 minutes.
const acceptLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: 'खूप प्रयत्न झाले — 15 मिनिटांनी परत करा.' });

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.ip || '').slice(0, 64);
}

// GET /api/teacher-rules — the current rules (public)
router.get('/', (_req, res) => {
  res.json({ success: true, data: RULES });
});

// POST /api/teacher-rules/accept  { teacher_code, pin, version }
router.post('/accept', acceptLimiter, asyncHandler(async (req, res) => {
  const code = String(req.body.teacher_code || '').trim().toUpperCase();
  const pin = String(req.body.pin || '').trim();
  if (!code || !/^\d{4}$/.test(pin)) throw new AppError('Teacher code आणि 4 अंकी PIN टाका', 400);
  if (String(req.body.version || '') !== RULES_VERSION) throw new AppError('नियम बदलले आहेत — page refresh करा', 409);
  if (req.body.agree !== true) throw new AppError('नियम मान्य करण्यासाठी ☑ करा', 400);

  const teacher = await User.findOne({ role: 'teacher', teacher_code: code });
  if (!teacher || !teacher.verifyPin(pin)) throw new AppError('Teacher code किंवा PIN चुकीचा', 401);

  teacher.rules_version_accepted = RULES_VERSION;
  teacher.rules_accepted_at = new Date();
  teacher.rules_accepted_ip = clientIp(req);
  await teacher.save();
  invalidateUserCache('teacher', teacher.user_id);

  res.json({ success: true, data: { name: teacher.name, teacher_code: code, version: RULES_VERSION, accepted_at: teacher.rules_accepted_at } });
}));

module.exports = router;
