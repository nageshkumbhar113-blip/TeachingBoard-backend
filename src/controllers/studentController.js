const { randomUUID } = require('crypto');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { normalizeExpiryDate } = require('../utils/accountStatus');

function normalizeBatches(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))];
}

function normalizeStudentCode(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizePin(value) {
  return String(value || '').trim();
}

// Reject trivially-guessable 4-digit PINs (all-same, sequential, repeating pairs)
function isWeakPin(pin) {
  if (!/^\d{4}$/.test(pin)) return true;
  if (/^(\d)\1{3}$/.test(pin)) return true;            // 0000, 1111…
  const [a, b, c, d] = pin.split('').map(Number);
  if (b === a + 1 && c === b + 1 && d === c + 1) return true;  // 1234…
  if (b === a - 1 && c === b - 1 && d === c - 1) return true;  // 9876…
  if (a === c && b === d) return true;                  // 1212…
  return false;
}

// Basic Indian mobile sanity: 10 digits, starts 6-9, not all-same
function isValidMobile(mobile) {
  if (!/^\d{10}$/.test(mobile)) return false;
  if (/^(\d)\1{9}$/.test(mobile)) return false;
  if (parseInt(mobile[0], 10) < 6) return false;
  return true;
}

function normalizeDate(value) {
  const clean = String(value || '').trim();
  if (!clean) return null;
  const parsed = new Date(clean);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError('Invalid expiry date', 400);
  }
  return new Date(parsed.toISOString().slice(0, 10));
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
    approved_at: student.approved_at || null,
    approved_by: student.approved_by || '',
    last_login_at: student.last_login_at || null,
    request_source: student.request_source || 'admin',
    created_at: student.created_at || null,
    updated_at: student.updated_at || null,
    school_name: student.school_name || '',
    device_bound: !!student.device_id,
    device_bound_at: student.device_bound_at || null,
    shared_device: !!student.shared_device,
  };
}

exports.getStudents = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 500, 1), 1000);
  const skip  = Math.max(parseInt(req.query.skip) || 0, 0);
  const students = await User.find({ role: 'student' }).sort({ created_at: -1 }).skip(skip).limit(limit).lean();
  res.json({
    success: true,
    count: students.length,
    skip,
    limit,
    data: students.map(serializeStudent),
  });
});

exports.createStudent = asyncHandler(async (req, res) => {
  const studentCode = normalizeStudentCode(req.body.student_code);
  const name = String(req.body.name || '').trim();
  const pin = normalizePin(req.body.pin);
  const status = String(req.body.status || 'active').trim().toLowerCase();

  if (!studentCode) throw new AppError('student_code is required', 400);
  if (!name) throw new AppError('name is required', 400);
  if (!pin || !/^\d{4}$/.test(pin)) throw new AppError('pin must be 4 digits', 400);
  if (!['pending', 'active', 'blocked'].includes(status)) throw new AppError('Invalid status', 400);

  const existing = await User.findOne({ student_code: studentCode, role: 'student' });
  if (existing) throw new AppError('Student code already exists', 409);

  const student = await User.create({
    user_id: `student-${randomUUID()}`,
    name,
    role: 'student',
    student_code: studentCode,
    mobile: String(req.body.mobile || '').trim(),
    status,
    assigned_batches: normalizeBatches(req.body.assigned_batches),
    expiry_date: normalizeDate(req.body.expiry_date),
    pin_hash: User.hashPin(pin),
    approved_at: status === 'active' ? new Date() : null,
    approved_by: String(req.user?.id || '').trim(),
    request_source: String(req.body.request_source || 'admin').trim() === 'self' ? 'self' : 'admin',
  });

  res.status(201).json({ success: true, data: serializeStudent(student) });
});

exports.updateStudent = asyncHandler(async (req, res) => {
  const student = await User.findOne({ user_id: req.params.id, role: 'student' });
  if (!student) throw new AppError('Student not found', 404);

  if (req.body.name !== undefined) {
    const name = String(req.body.name || '').trim();
    if (!name) throw new AppError('name is required', 400);
    student.name = name;
  }

  if (req.body.mobile !== undefined) {
    student.mobile = String(req.body.mobile || '').trim();
  }

  if (req.body.student_code !== undefined) {
    const studentCode = normalizeStudentCode(req.body.student_code);
    if (!studentCode) throw new AppError('student_code is required', 400);
    const existing = await User.findOne({
      student_code: studentCode,
      role: 'student',
      user_id: { $ne: student.user_id },
    });
    if (existing) throw new AppError('Student code already exists', 409);
    student.student_code = studentCode;
  }

  if (req.body.status !== undefined) {
    const status = String(req.body.status || '').trim().toLowerCase();
    if (!['pending', 'active', 'blocked'].includes(status)) throw new AppError('Invalid status', 400);
    student.status = status;
    if (status === 'active' && !student.approved_at) {
      student.approved_at = new Date();
      student.approved_by = String(req.user?.id || '').trim();
    }
  }

  if (req.body.assigned_batches !== undefined) {
    student.assigned_batches = normalizeBatches(req.body.assigned_batches);
  }

  if (req.body.expiry_date !== undefined) {
    student.expiry_date = normalizeDate(req.body.expiry_date);
  }

  if (req.body.pin !== undefined) {
    const pin = normalizePin(req.body.pin);
    if (!pin || !/^\d{4}$/.test(pin)) throw new AppError('pin must be 4 digits', 400);
    student.pin_hash = User.hashPin(pin);
  }

  if (req.body.shared_device !== undefined) {
    student.shared_device = !!req.body.shared_device;
    // If enabling shared_device, release device lock so any device can login
    if (student.shared_device) {
      student.device_id = null;
      student.device_bound_at = null;
    }
  }

  await student.save();

  // Propagate expiry to teacher and parent when expiry_date is updated
  if (req.body.expiry_date !== undefined) {
    const code = student.student_code;

    // Parent: same expiry as the student
    await User.updateMany(
      { role: 'parent', children: code },
      { $set: { expiry_date: student.expiry_date } }
    );

    // Teacher: expiry = MAX of all their assigned students' expiry dates
    // If any student has null expiry (unlimited), teacher stays unlimited too
    const teachers = await User.find(
      { role: 'teacher', assigned_students: code },
      'user_id assigned_students'
    ).lean();

    for (const teacher of teachers) {
      const codes = (teacher.assigned_students || []).filter(Boolean);
      if (!codes.length) continue;
      const peers = await User.find(
        { role: 'student', student_code: { $in: codes } },
        'expiry_date'
      ).lean();

      const newExpiry = peers.some(s => !s.expiry_date)
        ? null
        : peers.reduce((max, s) =>
            (!max || s.expiry_date > max) ? s.expiry_date : max, null);

      await User.updateOne(
        { user_id: teacher.user_id },
        { $set: { expiry_date: newExpiry } }
      );
    }
  }

  res.json({ success: true, data: serializeStudent(student) });
});

exports.resetDevice = asyncHandler(async (req, res) => {
  const student = await User.findOne({ user_id: req.params.id, role: 'student' });
  if (!student) throw new AppError('Student not found', 404);
  student.device_id = null;
  student.device_bound_at = null;
  await student.save();
  res.json({ success: true, message: 'Device binding reset' });
});

exports.deleteStudent = asyncHandler(async (req, res) => {
  const student = await User.findOne({ user_id: req.params.id, role: 'student' });
  if (!student) throw new AppError('Student not found', 404);
  await student.deleteOne();
  res.json({ success: true, message: 'Student deleted' });
});

exports.selfRegister = asyncHandler(async (req, res) => {
  const name        = String(req.body.name        || '').trim();
  const mobile      = String(req.body.mobile      || '').trim();
  const school_name = String(req.body.school_name || '').trim();
  const pin         = normalizePin(req.body.pin);

  if (!name)                          throw new AppError('Name is required', 400);
  if (!school_name)                   throw new AppError('School name is required', 400);
  if (!pin || !/^\d{4}$/.test(pin))   throw new AppError('PIN must be 4 digits', 400);
  if (isWeakPin(pin))                 throw new AppError('PIN is too weak (avoid 0000, 1234, repeating patterns)', 400);
  if (mobile && !isValidMobile(mobile)) throw new AppError('Invalid mobile number', 400);

  // Auto-generate unique student_code from name
  const prefix = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'STU';
  let student_code, attempts = 0;
  do {
    student_code = prefix + String(Math.floor(100 + Math.random() * 900));
    attempts++;
  } while (attempts < 10 && await User.findOne({ student_code, role: 'student' }));

  const student = await User.create({
    user_id:        `student-${randomUUID()}`,
    name,
    role:           'student',
    student_code,
    mobile,
    school_name,
    status:         'pending',
    request_source: 'self',
    pin_hash:       User.hashPin(pin),
  });

  res.status(201).json({
    success:      true,
    message:      'Registration request submitted. Wait for admin approval.',
    student_code: student.student_code,
    name:         student.name,
  });
});
