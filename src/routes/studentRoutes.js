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
const { getSyncState } = require('../controllers/syncStateController');
const { previewImport, runImport } = require('../controllers/studentImportController');

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
// Admin › Students › 📥 Import (many students at once; preview first, nothing saved)
router.post('/import/preview', requireAdmin, previewImport);
router.post('/import', requireAdmin, runImport);
router.patch('/:id', requireAdmin, updateStudent);
router.delete('/:id', requireAdmin, deleteStudent);
router.post('/:id/reset-device', requireAdmin, resetDevice);

// ── Student: /api/student (self-service, own account only) ──────────────────
const selfRouter = express.Router();
selfRouter.patch('/device-token', requireStudent, updateOwnDeviceToken);
selfRouter.get('/sync-state', requireStudent, getSyncState);

module.exports = { router, selfRouter };
