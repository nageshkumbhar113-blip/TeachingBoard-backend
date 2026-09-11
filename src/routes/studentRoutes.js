const express = require('express');
const { requireAdmin, requireStudent } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimiter');
const {
  createStudent,
  getStudents,
  updateStudent,
  resetDevice,
  deleteStudent,
  selfRegister,
  updateOwnDeviceToken,
} = require('../controllers/studentController');

const router = express.Router();

// 5 registration attempts per IP per hour
const registerLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many registration attempts. Please try again after an hour.',
});

router.post('/register', registerLimiter, selfRegister); // public — no auth needed
router.get('/', requireAdmin, getStudents);
router.post('/', requireAdmin, createStudent);
router.patch('/:id', requireAdmin, updateStudent);
router.delete('/:id', requireAdmin, deleteStudent);
router.post('/:id/reset-device', requireAdmin, resetDevice);

// ── Student: /api/student (self-service, own account only) ──────────────────
const selfRouter = express.Router();
selfRouter.patch('/device-token', requireStudent, updateOwnDeviceToken);

module.exports = { router, selfRouter };
