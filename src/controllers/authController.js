const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { createToken } = require('../utils/token');
const { isExpiredDate, normalizeExpiryDate } = require('../utils/accountStatus');

function normalizeBatches(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))];
}

function serializeStudent(student) {
  return {
    id: student.user_id,
    name: student.name,
    role: student.role,
    student_code: student.student_code || '',
    mobile: student.mobile || '',
    status: student.status || 'active',
    assigned_batches: normalizeBatches(student.assigned_batches),
    expiry_date: normalizeExpiryDate(student.expiry_date),
    shared_device: !!student.shared_device,
  };
}

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
      user: { id: adminDoc.user_id, name: adminDoc.name, role: 'admin' },
    });
  }

  const studentCode = String(req.body.student_code || '').trim().toUpperCase();
  const pin = String(req.body.pin || '').trim();

  if (!studentCode) {
    return res.status(400).json({ success: false, message: 'student_code is required for student login' });
  }

  if (!pin) {
    return res.status(400).json({ success: false, message: 'pin is required for student login' });
  }

  const student = await User.findOne({ student_code: studentCode, role: 'student' });
  if (!student) {
    return res.status(404).json({ success: false, message: 'Student account not found' });
  }

  if (!student.verifyPin(pin)) {
    return res.status(401).json({ success: false, message: 'Invalid student PIN' });
  }

  const deviceId = String(req.body.device_id || '').trim();
  let bindDevice = false;
  if (deviceId) {
    if (!student.device_id) {
      bindDevice = true;
    } else if (student.device_id !== deviceId && !student.shared_device) {
      // shared_device students can login from any device (siblings on same phone)
      return res.status(403).json({
        success: false,
        message: 'हे account दुसऱ्या device वर registered आहे. Admin ला reset करायला सांगा.',
        code: 'DEVICE_MISMATCH',
      });
    }
  }

  if (student.status === 'pending') {
    return res.status(403).json({ success: false, message: 'Approval pending', code: 'ACCOUNT_PENDING' });
  }

  if (student.status === 'blocked') {
    return res.status(403).json({ success: false, message: 'Student access is blocked', code: 'ACCOUNT_BLOCKED' });
  }

  const expiryDate = normalizeExpiryDate(student.expiry_date);
  if (expiryDate && isExpiredDate(expiryDate)) {
    return res.status(403).json({
      success: false,
      message: 'Student access expired',
      code: 'ACCOUNT_EXPIRED',
      expiryDate,
    });
  }

  student.last_login_at = new Date();
  if (bindDevice) {
    student.device_id = deviceId;
    student.device_bound_at = new Date();
  }
  await student.save();

  return res.json({
    success: true,
    message: 'Student login successful',
    token: createToken({
      id: student.user_id,
      name: student.name,
      role: 'student',
      student_code: student.student_code || '',
    }),
    user: serializeStudent(student),
  });
});

exports.me = asyncHandler(async (req, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const userDoc = await User.findOne({ user_id: req.user.id });
  if (!userDoc) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  if (userDoc.role === 'student') {
    if (userDoc.status === 'blocked') {
      return res.status(403).json({ success: false, message: 'Student access is blocked', code: 'ACCOUNT_BLOCKED' });
    }

    const expiryDate = normalizeExpiryDate(userDoc.expiry_date);
    if (expiryDate && isExpiredDate(expiryDate)) {
      return res.status(403).json({
        success: false,
        message: 'Student access expired',
        code: 'ACCOUNT_EXPIRED',
        expiryDate,
      });
    }
  }

  return res.json({
    success: true,
    user: userDoc.role === 'student'
      ? serializeStudent(userDoc)
      : { id: userDoc.user_id, name: userDoc.name, role: userDoc.role },
  });
});
