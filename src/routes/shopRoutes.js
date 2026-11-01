const express = require('express');
const c = require('../controllers/shopController');
const { requireAdmin, requireTeacher } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

const inviteLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, max: 120, message: 'खूप जास्त नंबर एकदम — थोड्या वेळाने पुन्हा करा',
  keyFn: req => String(req.headers.authorization || '').slice(-32),
});

// Shop panel (shop.html) — requireTeacher lets a shop through only to /api/shop/me*
router.get('/me', requireTeacher, c.me);
router.post('/me/invite', inviteLimiter, requireTeacher, c.invite);

// Admin > Partners > Shops
router.get('/admin/shops', requireAdmin, c.adminList);
router.post('/admin/shops', requireAdmin, c.adminCreate);
router.put('/admin/shops/:id', requireAdmin, c.adminUpdate);
router.get('/admin/shops/:id/students', requireAdmin, c.adminStudents);
router.get('/admin/shops/:id/settlement', requireAdmin, c.adminSettlement);

module.exports = router;
