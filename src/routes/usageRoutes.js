const express = require('express');
const c = require('../controllers/usageController');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// a phone sends at most a few times a day; keyed by the login, not the IP (school Wi-Fi)
const sendLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, max: 30, message: 'Too many requests',
  keyFn: req => String(req.headers.authorization || '').slice(-32),
});

router.get('/collect', requireAuth, c.collect);
router.post('/daily', sendLimiter, requireAuth, c.daily);
router.get('/admin', requireAdmin, c.admin);
router.post('/admin/collect', requireAdmin, c.adminCollect);

module.exports = router;
