// 🔔 /api/notify-schedule — Admin › Notifications: the automatic notifications' times / on-off, and the
// admin's own notifications (utils/notifySchedule.js)
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const NS = require('../utils/notifySchedule');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

const router = express.Router();
router.get('/', requireAdmin, asyncHandler(async (_req, res) => {
  const cfg = await NS.config(true);
  res.json({ success: true, data: { ...NS.view(cfg), wake: await NS.wakeTimes() } });
}));
router.put('/', requireAdmin, asyncHandler(async (req, res) => {
  let data;
  try { data = await NS.save(req.body || {}); } catch (err) { throw new AppError(err.message, err.status || 400); }
  require('../utils/adsAwake').soon(3000);   // the bot learns the new wake-up times
  res.json({ success: true, data: { ...data, wake: await NS.wakeTimes() } });
}));
module.exports = router;
