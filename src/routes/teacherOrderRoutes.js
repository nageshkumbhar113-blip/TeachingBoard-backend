// ➕ /api/teacher-orders — a teacher makes and pays for student accounts in the Teacher app (teacherOrderController)
const express = require('express');
const { requireTeacher } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimiter');
const c = require('../controllers/teacherOrderController');

const router = express.Router();
const limiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 60, message: 'खूप प्रयत्न झाले — थोड्या वेळाने करा.' });
router.get('/setup',          requireTeacher, c.setup);
router.post('/accept-rules',  requireTeacher, limiter, c.acceptRules);
router.post('/preview',       requireTeacher, limiter, c.preview);
router.post('/',              requireTeacher, limiter, c.create);
router.get('/:no',            requireTeacher, c.get);
module.exports = router;
