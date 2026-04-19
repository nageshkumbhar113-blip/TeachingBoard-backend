const { randomUUID }  = require('crypto');
const User            = require('../models/User');
const asyncHandler    = require('../utils/asyncHandler');
const { createToken } = require('../utils/token');

exports.login = asyncHandler(async (req, res) => {
  const role = String(req.body.role || '').trim().toLowerCase();

  if (!['admin', 'student'].includes(role)) {
    return res.status(400).json({ success: false, message: 'role must be admin or student' });
  }

  // ── Admin login ──────────────────────────────────────────
  if (role === 'admin') {
    const pin = String(req.body.pin || '').trim();
    if (!pin) {
      return res.status(400).json({ success: false, message: 'pin is required for admin login' });
    }

    const adminDoc = await User.findOne({ role: 'admin' });
    if (!adminDoc) {
      return res.status(503).json({ success: false, message: 'Admin account not initialised' });
    }

    if (!adminDoc.verifyPin(pin)) {
      return res.status(401).json({ success: false, message: 'Invalid admin PIN' });
    }

    return res.json({
      success: true,
      message: 'Admin login successful',
      token: createToken({ id: adminDoc.user_id, name: adminDoc.name, role: 'admin' }),
      user:  { id: adminDoc.user_id, name: adminDoc.name, role: 'admin' },
    });
  }

  // ── Student login — create on first visit ────────────────
  const name = String(req.body.name || '').trim();
  if (!name) {
    return res.status(400).json({ success: false, message: 'name is required for student login' });
  }

  let student = await User.findOne({ name, role: 'student' });
  if (!student) {
    student = await User.create({
      user_id: `student-${randomUUID()}`,
      name,
      role:    'student',
    });
  }

  res.json({
    success: true,
    message: 'Student login successful',
    token: createToken({ id: student.user_id, name: student.name, role: 'student' }),
    user:  { id: student.user_id, name: student.name, role: 'student' },
  });
});
