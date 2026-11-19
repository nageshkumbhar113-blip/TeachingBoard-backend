// 🎯 /api/teacher-demo — a teacher books a demo from an ad (utils/teacherDemo.js)
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimiter');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const D = require('../utils/teacherDemo');

const router = express.Router();
const bookLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 15, message: 'खूप प्रयत्न झाले — थोड्या वेळाने करा किंवा 8390484545 वर संपर्क करा.' });
const ipOf = req => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '').slice(0, 64);

router.post('/book', bookLimiter, asyncHandler(async (req, res) => {
  try { res.json({ success: true, data: await D.book(req.body || {}, ipOf(req)) }); }
  catch (err) { throw new AppError(err.message, err.status || 400); }
}));
// Admin › Ads › Teacher demo: on / off, hours, course
router.get('/admin/config', requireAdmin, asyncHandler(async (_req, res) => res.json({ success: true, data: await D.config() })));
router.put('/admin/config', requireAdmin, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const set = { on: b.on !== false, hours: Math.max(1, Math.min(240, Number(b.hours) || 48)), course: String(b.course || '').trim().slice(0, 120) };
  await D.DemoConfig.updateOne({ key: 'main' }, { $set: set }, { upsert: true });
  res.json({ success: true, data: await D.config() });
}));
// Admin › Teachers: the school demo student on (till 30 April) / off
router.post('/admin/student/:code', requireAdmin, asyncHandler(async (req, res) => {
  try { res.json({ success: true, data: await D.adminSwitch(req.params.code, req.body?.on === true) }); }
  catch (err) { throw new AppError(err.message, err.status || 400); }
}));
module.exports = router;
