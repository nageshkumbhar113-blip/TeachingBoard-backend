const store        = require('../store');
const asyncHandler = require('../utils/asyncHandler');
const { createToken } = require('../utils/token');

exports.login = asyncHandler(async (req, res) => {
  const role = String(req.body.role || '').trim().toLowerCase();

  if (!['admin', 'student'].includes(role)) {
    return res.status(400).json({ success: false, message: 'role must be admin or student' });
  }

  if (role === 'admin') {
    const pin = String(req.body.pin || '').trim();
    if (!pin) {
      return res.status(400).json({ success: false, message: 'pin is required for admin login' });
    }

    const user = store.getBy('users', 'pin', pin);
    if (!user || user.role !== 'admin') {
      return res.status(401).json({ success: false, message: 'Invalid admin PIN' });
    }

    return res.json({
      success: true,
      message: 'Admin login successful',
      token: createToken(user),
      user: { id: user.id, name: user.name, role: user.role },
    });
  }

  // Student login — create on first visit
  const name = String(req.body.name || '').trim();
  if (!name) {
    return res.status(400).json({ success: false, message: 'name is required for student login' });
  }

  let user = store.getBy('users', 'name', name);
  if (!user || user.role !== 'student') {
    user = store.insert('users', {
      id  : `student-${Date.now()}`,
      name,
      role: 'student',
      pin : null,
    });
  }

  res.json({
    success: true,
    message: 'Student login successful',
    token: createToken(user),
    user: { id: user.id, name: user.name, role: user.role },
  });
});
