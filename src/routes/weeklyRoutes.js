const express = require('express');
const c = require('../controllers/weeklyController');
const { attachUserIfPresent, requireAdmin } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
// Per person (token), not per IP: a whole class submits from one school Wi-Fi at the same time.
const small = createRateLimiter({ windowMs: 60 * 1000, max: 30, message: 'Too many requests — please try again later', keyFn: req => String(req.headers.authorization || req.ip || 'x').slice(-40) });

router.get('/admin/schedules', requireAdmin, c.adminSchedules);
router.post('/admin/schedules', requireAdmin, c.adminSaveSchedule);
router.put('/admin/schedules/:id', requireAdmin, c.adminSaveSchedule);
router.delete('/admin/schedules/:id', requireAdmin, c.adminDeleteSchedule);
router.post('/admin/schedules/:id/trial', requireAdmin, c.adminTrial);
router.get('/admin/pool', requireAdmin, c.adminPool);
router.get('/admin/events', requireAdmin, c.adminEvents);
router.get('/admin/events/:id', requireAdmin, c.adminEventResults);
router.delete('/admin/events/:id', requireAdmin, c.adminDeleteEvent);

router.get('/my', attachUserIfPresent, c.my);
router.post('/toppers/privacy', small, attachUserIfPresent, c.toppersPrivacy);
router.post('/:id/register', small, attachUserIfPresent, c.register);
router.get('/:id/paper', small, attachUserIfPresent, c.paper);
router.get('/:id/key', small, attachUserIfPresent, c.key);
router.post('/:id/submit', small, attachUserIfPresent, c.submit);
router.get('/:id/result', small, attachUserIfPresent, c.result);

module.exports = router;
