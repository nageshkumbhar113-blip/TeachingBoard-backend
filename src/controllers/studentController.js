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
    device_bound: !!student.device_id,
    device_bound_at: student.device_bound_at || null,
  };
}

exports.getStudents = asyncHandler(async (_req, res) => {
  const students = await User.find({ role: 'student' }).sort({ created_at: -1 }).lean();
  res.json({
    success: true,
    count: students.length,
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

  await student.save();
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
