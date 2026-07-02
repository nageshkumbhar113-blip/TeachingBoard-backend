const { randomUUID } = require('crypto');
const User = require('../models/User');
const Attempt = require('../models/Attempt');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeStudentCodes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => normalizeCode(item)).filter(Boolean))];
}

function serializeTeacher(t) {
  return {
    id: t.user_id,
    name: t.name,
    role: 'teacher',
    teacher_code: t.teacher_code || '',
    mobile: t.mobile || '',
    assigned_students: Array.isArray(t.assigned_students) ? t.assigned_students : [],
    last_login_at: t.last_login_at || null,
    created_at: t.created_at || null,
  };
}

// ── Admin: CRUD ──────────────────────────────────────────────────────────────

exports.getTeachers = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 1000);
  const skip  = Math.max(parseInt(req.query.skip) || 0, 0);
  const teachers = await User.find({ role: 'teacher' })
    .sort({ created_at: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
  res.json({ success: true, count: teachers.length, skip, limit, data: teachers.map(serializeTeacher) });
});

exports.createTeacher = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const pin  = String(req.body.pin  || '').trim();
  let teacherCode = normalizeCode(req.body.teacher_code);

  if (!name) throw new AppError('name is required', 400);
  if (!pin || !/^\d{4}$/.test(pin)) throw new AppError('pin must be 4 digits', 400);

  // Auto-generate teacher_code if not provided
  if (!teacherCode) {
    const prefix = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'TCH';
    let attempts = 0;
    do {
      teacherCode = prefix + String(Math.floor(100 + Math.random() * 900));
      attempts++;
    } while (attempts < 10 && await User.findOne({ teacher_code: teacherCode }));
  } else {
    const existing = await User.findOne({ teacher_code: teacherCode });
    if (existing) throw new AppError('Teacher code already exists', 409);
  }

  const teacher = await User.create({
    user_id: `teacher-${randomUUID()}`,
    name,
    role: 'teacher',
    teacher_code: teacherCode,
    mobile: String(req.body.mobile || '').trim(),
    assigned_students: normalizeStudentCodes(req.body.assigned_students),
    pin_hash: User.hashPin(pin),
  });

  res.status(201).json({ success: true, data: serializeTeacher(teacher), pin });
});

exports.updateTeacher = asyncHandler(async (req, res) => {
  const teacher = await User.findOne({ user_id: req.params.id, role: 'teacher' });
  if (!teacher) throw new AppError('Teacher not found', 404);

  if (req.body.name !== undefined) {
    const name = String(req.body.name || '').trim();
    if (!name) throw new AppError('name is required', 400);
    teacher.name = name;
  }

  if (req.body.mobile !== undefined) {
    teacher.mobile = String(req.body.mobile || '').trim();
  }

  if (req.body.assigned_students !== undefined) {
    teacher.assigned_students = normalizeStudentCodes(req.body.assigned_students);
  }

  if (req.body.pin !== undefined) {
    const pin = String(req.body.pin || '').trim();
    if (!pin || !/^\d{4}$/.test(pin)) throw new AppError('pin must be 4 digits', 400);
    teacher.pin_hash = User.hashPin(pin);
  }

  await teacher.save();
  res.json({ success: true, data: serializeTeacher(teacher) });
});

exports.deleteTeacher = asyncHandler(async (req, res) => {
  const teacher = await User.findOne({ user_id: req.params.id, role: 'teacher' });
  if (!teacher) throw new AppError('Teacher not found', 404);
  await teacher.deleteOne();
  res.json({ success: true, message: 'Teacher deleted' });
});

// Students not present in ANY teacher's assigned_students list — for the
// admin "Assign students" checklist on the Teachers screen.
exports.getUnassignedStudents = asyncHandler(async (req, res) => {
  const teachers = await User.find({ role: 'teacher' }, 'assigned_students').lean();
  const assignedCodes = new Set(teachers.flatMap(t => t.assigned_students || []));

  const students = await User.find({ role: 'student' })
    .select('user_id name student_code mobile status')
    .sort({ name: 1 })
    .lean();

  const unassigned = students
    .filter(s => s.student_code && !assignedCodes.has(s.student_code))
    .map(s => ({
      id: s.user_id,
      name: s.name,
      student_code: s.student_code,
      mobile: s.mobile || '',
      status: s.status || 'active',
    }));

  res.json({ success: true, count: unassigned.length, data: unassigned });
});

// ── Teacher: own student progress ────────────────────────────────────────────

exports.getMyStudents = asyncHandler(async (req, res) => {
  const teacherDoc = req.userDoc || await User.findOne({ user_id: req.user.id }).lean();
  if (!teacherDoc) throw new AppError('Teacher not found', 404);

  const studentCodes = Array.isArray(teacherDoc.assigned_students)
    ? teacherDoc.assigned_students.filter(Boolean)
    : [];

  if (!studentCodes.length) {
    return res.json({ success: true, data: [] });
  }

  // Fetch student records
  const students = await User.find({ student_code: { $in: studentCodes }, role: 'student' })
    .select('user_id name student_code mobile school_name assigned_batches')
    .lean();

  // Aggregate attempt stats per student
  const statsPipeline = [
    { $match: { student_code: { $in: studentCodes } } },
    {
      $group: {
        _id: '$student_code',
        total_attempts: { $sum: 1 },
        total_score: { $sum: '$score' },
        total_questions: { $sum: '$total_questions' },
        last_attempt: { $max: '$submitted_at' },
      }
    }
  ];
  const stats = await Attempt.aggregate(statsPipeline);
  const statsMap = new Map(stats.map(s => [s._id, s]));

  const data = students.map(s => {
    const st = statsMap.get(s.student_code) || {};
    const totalQ = st.total_questions || 0;
    return {
      student_code: s.student_code,
      name: s.name,
      mobile: s.mobile || '',
      school_name: s.school_name || '',
      assigned_batches: s.assigned_batches || [],
      total_attempts: st.total_attempts || 0,
      avg_score_pct: totalQ > 0 ? Math.round((st.total_score / totalQ) * 100) : 0,
      last_attempt: st.last_attempt || null,
    };
  });

  res.json({ success: true, data });
});

exports.getStudentAttempts = asyncHandler(async (req, res) => {
  const teacherDoc = req.userDoc || await User.findOne({ user_id: req.user.id }).lean();
  if (!teacherDoc) throw new AppError('Teacher not found', 404);

  const studentCode = normalizeCode(req.params.code);
  if (!studentCode) throw new AppError('student_code is required', 400);

  // Verify the student is assigned to this teacher
  const assignedCodes = Array.isArray(teacherDoc.assigned_students)
    ? teacherDoc.assigned_students.map(normalizeCode)
    : [];
  if (!assignedCodes.includes(studentCode)) {
    throw new AppError('Student not assigned to this teacher', 403);
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const skip  = Math.max(parseInt(req.query.skip) || 0, 0);

  const attempts = await Attempt.find({ student_code: studentCode })
    .sort({ submitted_at: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  res.json({ success: true, count: attempts.length, skip, limit, data: attempts });
});

// ── Teacher: Analytics ───────────────────────────────────────────────────────

async function _getTeacherStudentCodes(req) {
  const teacherDoc = req.userDoc || await User.findOne({ user_id: req.user.id }).lean();
  if (!teacherDoc) throw new AppError('Teacher not found', 404);
  return Array.isArray(teacherDoc.assigned_students)
    ? teacherDoc.assigned_students.filter(Boolean)
    : [];
}

// GET /api/teacher/analytics/weekly — attempts per day for last 7 days
exports.getWeeklyAnalytics = asyncHandler(async (req, res) => {
  const studentCodes = await _getTeacherStudentCodes(req);
  if (!studentCodes.length) return res.json({ success: true, data: [] });

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const raw = await Attempt.aggregate([
    { $match: { student_code: { $in: studentCodes }, submitted_at: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$submitted_at' } },
        count:           { $sum: 1 },
        total_score:     { $sum: '$score' },
        total_questions: { $sum: '$total_questions' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  // Fill missing days with zero so chart always has 7 bars
  const byDay = new Map(raw.map(r => [r._id, r]));
  const data = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const r = byDay.get(key);
    data.push({
      date:    key,
      label:   d.toLocaleDateString('mr-IN', { weekday: 'short' }),
      count:   r?.count || 0,
      avg_pct: r && r.total_questions > 0
        ? Math.round((r.total_score / r.total_questions) * 100)
        : 0,
    });
  }

  res.json({ success: true, data });
});

// GET /api/teacher/analytics/monthly — attempts per week for last 4 weeks
exports.getMonthlyAnalytics = asyncHandler(async (req, res) => {
  const studentCodes = await _getTeacherStudentCodes(req);
  if (!studentCodes.length) return res.json({ success: true, data: [] });

  const since = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);

  const raw = await Attempt.aggregate([
    { $match: { student_code: { $in: studentCodes }, submitted_at: { $gte: since } } },
    {
      $group: {
        _id: {
          year: { $isoWeekYear: '$submitted_at' },
          week: { $isoWeek:     '$submitted_at' },
        },
        count:           { $sum: 1 },
        total_score:     { $sum: '$score' },
        total_questions: { $sum: '$total_questions' },
        week_start:      { $min: '$submitted_at' },
      },
    },
    { $sort: { week_start: 1 } },
  ]);

  // Ensure exactly 4 buckets (fill empty weeks with 0)
  const MS_WEEK = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const data = [];
  for (let w = 3; w >= 0; w--) {
    const weekStart = new Date(now - (w + 1) * MS_WEEK);
    const weekEnd   = new Date(now - w       * MS_WEEK);
    const match = raw.find(r => r.week_start >= weekStart && r.week_start < weekEnd);
    data.push({
      label:   `W${4 - w}`,
      week_of: weekStart.toLocaleDateString('mr-IN', { day: 'numeric', month: 'short' }),
      count:   match?.count || 0,
      avg_pct: match && match.total_questions > 0
        ? Math.round((match.total_score / match.total_questions) * 100)
        : 0,
    });
  }

  res.json({ success: true, data });
});

// GET /api/teacher/analytics/weak-topics — subjects with highest wrong %
exports.getWeakTopics = asyncHandler(async (req, res) => {
  const studentCodes = await _getTeacherStudentCodes(req);
  if (!studentCodes.length) return res.json({ success: true, data: [] });

  const data = await Attempt.aggregate([
    { $match: { student_code: { $in: studentCodes }, total_questions: { $gt: 0 } } },
    {
      $group: {
        _id:             '$subject',
        total_attempts:  { $sum: 1 },
        total_wrong:     { $sum: '$wrong_answers' },
        total_correct:   { $sum: '$correct_answers' },
        total_questions: { $sum: '$total_questions' },
      },
    },
    {
      $addFields: {
        wrong_pct: {
          $round: [
            { $multiply: [{ $divide: ['$total_wrong', '$total_questions'] }, 100] },
            0,
          ],
        },
      },
    },
    { $match: { total_attempts: { $gte: 1 } } },
    { $sort: { wrong_pct: -1 } },
    { $limit: 10 },
    { $project: { _id: 0, subject: '$_id', total_attempts: 1, total_wrong: 1, total_questions: 1, wrong_pct: 1 } },
  ]);

  res.json({ success: true, data });
});

// GET /api/teacher/analytics/strong-topics — subjects with highest correct %
exports.getStrongTopics = asyncHandler(async (req, res) => {
  const studentCodes = await _getTeacherStudentCodes(req);
  if (!studentCodes.length) return res.json({ success: true, data: [] });

  const data = await Attempt.aggregate([
    { $match: { student_code: { $in: studentCodes }, total_questions: { $gt: 0 } } },
    {
      $group: {
        _id:             '$subject',
        total_attempts:  { $sum: 1 },
        total_correct:   { $sum: '$correct_answers' },
        total_questions: { $sum: '$total_questions' },
      },
    },
    {
      $addFields: {
        correct_pct: {
          $round: [
            { $multiply: [{ $divide: ['$total_correct', '$total_questions'] }, 100] },
            0,
          ],
        },
      },
    },
    { $match: { total_attempts: { $gte: 1 } } },
    { $sort: { correct_pct: -1 } },
    { $limit: 10 },
    { $project: { _id: 0, subject: '$_id', total_attempts: 1, total_correct: 1, total_questions: 1, correct_pct: 1 } },
  ]);

  res.json({ success: true, data });
});

// GET /api/teacher/analytics/ranking — students ranked by avg score %
exports.getRanking = asyncHandler(async (req, res) => {
  const studentCodes = await _getTeacherStudentCodes(req);
  if (!studentCodes.length) return res.json({ success: true, data: [] });

  const data = await Attempt.aggregate([
    { $match: { student_code: { $in: studentCodes } } },
    {
      $group: {
        _id:             '$student_code',
        total_attempts:  { $sum: 1 },
        total_score:     { $sum: '$score' },
        total_questions: { $sum: '$total_questions' },
        student_name:    { $last: '$student_name' },
      },
    },
    {
      $addFields: {
        avg_pct: {
          $cond: [
            { $gt: ['$total_questions', 0] },
            { $round: [{ $multiply: [{ $divide: ['$total_score', '$total_questions'] }, 100] }, 0] },
            0,
          ],
        },
      },
    },
    { $sort: { avg_pct: -1, total_attempts: -1 } },
    {
      $project: {
        _id: 0,
        student_code:   '$_id',
        name:           '$student_name',
        total_attempts: 1,
        avg_pct:        1,
      },
    },
  ]);

  res.json({ success: true, data });
});

// ── Teacher: register FCM device token ───────────────────────────────────────

exports.updateDeviceToken = asyncHandler(async (req, res) => {
  const token = String(req.body.device_token || '').trim();
  if (!token) throw new AppError('device_token is required', 400);

  await User.updateOne({ user_id: req.user.id }, { $set: { device_token: token } });
  res.json({ success: true, message: 'Device token updated' });
});
