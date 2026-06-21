const { randomUUID }   = require('crypto');
const User             = require('../models/User');
const Notification     = require('../models/Notification');
const { sendToMany }   = require('../utils/fcm');
const asyncHandler     = require('../utils/asyncHandler');
const AppError         = require('../utils/AppError');

function normalizeCode(v) {
  return String(v || '').trim().toUpperCase();
}

// POST /api/teacher/send-notification
exports.sendNotification = asyncHandler(async (req, res) => {
  const teacherDoc = req.userDoc || await User.findOne({ user_id: req.user.id }).lean();
  if (!teacherDoc) throw new AppError('Teacher not found', 404);

  const type        = String(req.body.type || '').trim();
  const title       = String(req.body.title || '').trim();
  const body        = String(req.body.body  || '').trim();
  const batch       = String(req.body.batch        || '').trim() || null;
  const studentCode = normalizeCode(req.body.student_code || '');

  if (!['batch', 'individual'].includes(type)) throw new AppError('type must be batch or individual', 400);
  if (!title) throw new AppError('title is required', 400);
  if (!body)  throw new AppError('body is required', 400);
  if (type === 'batch' && !batch) throw new AppError('batch is required for batch notifications', 400);
  if (type === 'individual' && !studentCode) throw new AppError('student_code is required for individual notifications', 400);

  const assignedCodes = Array.isArray(teacherDoc.assigned_students)
    ? teacherDoc.assigned_students.filter(Boolean)
    : [];

  let targetStudentCodes = [];

  if (type === 'batch') {
    // Students in this batch, intersected with teacher's assigned students
    const batchStudents = await User.find({
      role: 'student',
      student_code: { $in: assignedCodes },
      assigned_batches: batch,
    }).select('student_code').lean();
    targetStudentCodes = batchStudents.map(s => s.student_code).filter(Boolean);
  } else {
    // Individual — verify the student is assigned to this teacher
    if (!assignedCodes.map(normalizeCode).includes(studentCode)) {
      throw new AppError('Student not assigned to this teacher', 403);
    }
    targetStudentCodes = [studentCode];
  }

  if (!targetStudentCodes.length) {
    return res.json({ success: true, recipient_count: 0, message: 'No students found in this batch' });
  }

  // Find parents of target students
  const parents = await User.find({
    role: 'parent',
    children: { $in: targetStudentCodes },
    device_token: { $exists: true, $nin: [null, ''] },
  }).select('device_token').lean();

  const tokens = [...new Set(parents.map(p => p.device_token).filter(Boolean))];

  if (tokens.length) {
    const data = {
      type,
      batch:        batch        || '',
      student_code: studentCode  || '',
      sent_by:      teacherDoc.user_id,
    };
    await sendToMany(tokens, title, body, data).catch(err =>
      console.warn('Notification sendToMany partial failure:', err.message)
    );
  }

  await Notification.create({
    notification_id: randomUUID(),
    sent_by:         teacherDoc.user_id,
    sent_by_name:    teacherDoc.name || '',
    type,
    batch:           batch || null,
    student_code:    type === 'individual' ? studentCode : null,
    title,
    body,
    sent_at:         new Date(),
    recipient_count: tokens.length,
  });

  res.json({ success: true, recipient_count: tokens.length });
});

// GET /api/teacher/notification-history
exports.getNotificationHistory = asyncHandler(async (req, res) => {
  const teacherDoc = req.userDoc || await User.findOne({ user_id: req.user.id }).lean();
  if (!teacherDoc) throw new AppError('Teacher not found', 404);

  const filter = { sent_by: teacherDoc.user_id };

  const studentCode = normalizeCode(req.query.student_code || '');
  if (studentCode) filter.student_code = studentCode;

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const skip  = Math.max(parseInt(req.query.skip) || 0, 0);

  const notifications = await Notification.find(filter)
    .sort({ sent_at: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  res.json({ success: true, count: notifications.length, data: notifications });
});
