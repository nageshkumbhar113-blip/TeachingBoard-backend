const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const {
  createStudent,
  getStudents,
  updateStudent,
  resetDevice,
  selfRegister,
} = require('../controllers/studentController');

const router = express.Router();

router.post('/register', selfRegister);          // public — no auth needed
router.get('/', requireAdmin, getStudents);
router.post('/', requireAdmin, createStudent);
router.patch('/:id', requireAdmin, updateStudent);
router.post('/:id/reset-device', requireAdmin, resetDevice);

module.exports = router;
