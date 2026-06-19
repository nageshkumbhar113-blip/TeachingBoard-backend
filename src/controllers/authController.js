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

function serializeTeacher(teacher) {
  return {
    id: teacher.user_id,
    name: teacher.name,
    role: teacher.role,
    teacher_code: teacher.teacher_code || '',
    mobile: teacher.mobile || '',
    assigned_students: Array.isArray(teacher.assigned_students) ? teacher.assigned_students : [],
  };
}

function serializeParent(parent) {
  return {
    id: parent.user_id,
    name: parent.name,
    role: parent.role,
    parent_code: parent.parent_code || '',
    mobile: parent.mobile || '',
    children: Array.isArray(parent.children) ? parent.children : [],
  };
}

exports.login = asyncHandler(async (req, res) => {
  const role = String(req.body.role || '').trim().toLowerCase();

  if (!['admin', 'student', 'teacher', 'parent'].includes(role)) {
    return res.status(400).json({ success: false, message: 'role must be admin, student, teacher, or parent' });
  }

  // ── Admin login ──────────────────────────────────
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

  // ── Teacher login ────────────────────────────────
  if (role === 'teacher') {
    const teacherCode = String(req.body.teacher_code || '').trim().toUpperCase();
    const pin = String(req.body.pin || '').trim();

    if (!teacherCode) return res.status(400).json({ success: false, message: 'teacher_code is required' });
    if (!pin)         return res.status(400).json({ success: false, message: 'pin is required' });

    const teacher = await User.findOne({ teacher_code: teacherCode, role: 'teacher' });
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher account not found' });

    if (!teacher.verifyPin(pin)) {
      return res.status(401).json({ success: false, message: 'Invalid teacher PIN' });
    }

    teacher.last_login_at = new Date();
    await teacher.save();

    return res.json({
      success: true,
      message: 'Teacher login successful',
      token: createToken({
        id: teacher.user_id,
        name: teacher.name,
        role: 'teacher',
        teacher_code: teacher.teacher_code || '',
      }),
      user: serializeTeacher(teacher),
    });
  }

  // ── Parent login ─────────────────────────────────
  if (role === 'parent') {
    const parentCode = String(req.body.parent_code || '').trim().toUpperCase();
    const pin = String(req.body.pin || '').trim();

    if (!parentCode) return res.status(400).json({ success: false, message: 'parent_code is required' });
    if (!pin)        return res.status(400).json({ success: false, message: 'pin is required' });

    const parent = await User.findOne({ parent_code: parentCode, role: 'parent' });
    if (!parent) return res.status(404).json({ success: false, message: 'Parent account not found' });

    if (!parent.verifyPin(pin)) {
      return res.status(401).json({ success: false, message: 'Invalid parent PIN' });
    }

    parent.last_login_at = new Date();
    await parent.save();

    return res.json({
      success: true,
      message: 'Parent login successful',
      token: createToken({
        id: parent.user_id,
        name: parent.name,
        role: 'parent',
        parent_code: parent.parent_code || '',
      }),
      user: serializeParent(parent),
    });
  }

  // ── Student login ────────────────────────────────
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

    return res.json({
      success: true,
      user: {
        id: userDoc.user_id,
        name: userDoc.name,
        role: userDoc.role,
        student_code: userDoc.student_code || '',
        mobile: userDoc.mobile || '',
        status: userDoc.status || 'active',
        assigned_batches: Array.isArray(userDoc.assigned_batches) ? userDoc.assigned_batches : [],
        expiry_date: normalizeExpiryDate(userDoc.expiry_date),
        shared_device: !!userDoc.shared_device,
      },
    });
  }

  if (userDoc.role === 'teacher') {
    return res.json({
      success: true,
      user: {
        id: userDoc.user_id,
        name: userDoc.name,
        role: userDoc.role,
        teacher_code: userDoc.teacher_code || '',
        mobile: userDoc.mobile || '',
        assigned_students: Array.isArray(userDoc.assigned_students) ? userDoc.assigned_students : [],
      },
    });
  }

  if (userDoc.role === 'parent') {
    return res.json({
      success: true,
      user: {
        id: userDoc.user_id,
        name: userDoc.name,
        role: userDoc.role,
        parent_code: userDoc.parent_code || '',
        mobile: userDoc.mobile || '',
        children: Array.isArray(userDoc.children) ? userDoc.children : [],
      },
    });
  }

  return res.json({
    success: true,
    user: { id: userDoc.user_id, name: userDoc.name, role: userDoc.role },
  });
});
