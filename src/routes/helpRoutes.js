const express = require('express');
const c = require('../controllers/helpController');
const { requireAdmin } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
const MSG = 'खूप प्रयत्न झाले — थोड्या वेळाने पुन्हा करा';
const ip = req => req.ip || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';

// Guessing is stopped per phone (device id), per number, and per network.
const perDevice = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5, message: MSG, keyFn: req => 'd:' + String(req.body?.device_id || ip(req)).slice(0, 100) });
const perMobile = createRateLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 10, message: MSG, keyFn: req => 'm:' + String(req.body?.mobile || '').replace(/\D/g, '').slice(-10) });
const perIp     = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 60, message: MSG });
const resetLimit = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10, message: MSG });
const small     = createRateLimiter({ windowMs: 60 * 1000, max: 30, message: MSG });

router.get('/faq', c.faq);
router.post('/hit', small, c.hit);
router.post('/recover', perIp, perDevice, perMobile, c.recover);
router.post('/reset-pin', resetLimit, c.resetPin);
router.post('/move-device', resetLimit, c.moveDevice);
router.post('/pin-request', perIp, perMobile, c.pinRequest);

router.get('/admin', requireAdmin, c.adminOverview);
router.put('/admin/faq', requireAdmin, c.adminFaqSave);
router.post('/admin/pin-requests/:id/resolve', requireAdmin, c.adminResolve);
router.post('/admin/pin-requests/:id/reject', requireAdmin, c.adminReject);

module.exports = router;
