const express = require('express');
const c = require('../controllers/teacherConnectController');
const { requireStudent } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
const small = createRateLimiter({ windowMs: 60 * 1000, max: 30, message: 'Too many requests' });

router.get('/info/:code', small, c.info);
// student
router.post('/join', small, requireStudent, c.join);
router.get('/mine', requireStudent, c.mine);

module.exports = router;
