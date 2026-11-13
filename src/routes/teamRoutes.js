// 👥 /api/team — the "NKs Team" app's login + Admin › Settings › 👥 Team
const express = require('express');
const router = express.Router();
const c = require('../controllers/teamController');
const { requireAdmin } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimiter');

// a wrong PIN again and again: wait (per number, and per network)
const byNumber = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: 'खूप वेळा चुकलं — 15 मिनिटांनी पुन्हा', keyFn: req => 'team:' + String(req.body?.mobile || '').replace(/\D/g, '').slice(-10) });
const byIp = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 60, message: 'खूप वेळा चुकलं — 15 मिनिटांनी पुन्हा' });

router.post('/login', byIp, byNumber, c.login);
router.get('/me', c.requireAdminOrStaff, c.me);
router.get('/admin/members', requireAdmin, c.list);
router.post('/admin/members', requireAdmin, c.create);
router.patch('/admin/members/:id', requireAdmin, c.update);
router.delete('/admin/members/:id', requireAdmin, c.remove);

module.exports = router;
