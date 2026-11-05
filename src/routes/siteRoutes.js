const express = require('express');
const c = require('../controllers/siteController');
const { requireAdmin } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
const pub = createRateLimiter({ windowMs: 60 * 1000, max: 60, message: 'थोड्या वेळाने पुन्हा करा' });

router.get('/exams', pub, c.publicExams);   // the Vercel build reads this

router.get('/admin/exams', requireAdmin, c.adminList);
router.post('/admin/seed', requireAdmin, c.adminSeed);
router.put('/admin/exams/:slug', requireAdmin, c.adminSave);
router.post('/admin/publish', requireAdmin, c.adminPublish);

module.exports = router;
