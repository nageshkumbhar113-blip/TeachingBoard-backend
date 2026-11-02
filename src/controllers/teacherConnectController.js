const User = require('../models/User');
const TeacherJoinRequest = require('../models/TeacherJoinRequest');
const StudentSubscription = require('../models/StudentSubscription');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { invalidateUserCache } = require('../middleware/auth');

// "Connect student" (teacher's join link / QR / code) for students who are
// already registered — they join at once (the teacher shares the link himself). Joining later is for teaching only (marks, notifications,
// papers): the commission owner never changes — except a student with no owner
// at all who has not paid yet; the accepting teacher becomes the owner then.

const _code = v => String(v || '').trim().toUpperCase().slice(0, 30);

// Only real (school / institute) teachers can be joined — not YouTube partners or shops.
async function _teacher(code) {
  const t = await User.findOne({ role: 'teacher', teacher_code: _code(code) }).lean();
  if (!t || (t.partner_type && t.partner_type !== 'school') || (t.status || 'active') !== 'active') return null;
  return t;
}

async function _link(teacher, studentCode) {
  await User.updateOne({ _id: teacher._id }, { $addToSet: { assigned_students: studentCode } });
  invalidateUserCache('teacher', teacher.user_id);
  const s = await User.findOne({ role: 'student', student_code: studentCode });
  if (s && !s.referred_by_teacher && !s.referred_by_student) {
    const paid = await StudentSubscription.exists({ student_code: studentCode, payment_verified: true, is_trial: false });
    if (!paid) { s.referred_by_teacher = teacher.teacher_code; await s.save(); invalidateUserCache('student', s.user_id); }
  }
}

// GET /api/teacher-connect/info/:code — who the student is joining (public, tiny)
exports.info = asyncHandler(async (req, res) => {
  const t = await _teacher(req.params.code);
  if (!t) throw new AppError('हा teacher code सापडला नाही', 404);
  res.json({ success: true, data: { code: t.teacher_code, name: t.name, institute: t.institute_name || '' } });
});

// ── Student ─────────────────────────────────────────────────────────────
function _student(req) {
  const u = req.userDoc;
  if (!u || u.role !== 'student' || req.user?.guest) throw new AppError('Login required', 401);
  return u;
}

// POST /api/teacher-connect/join { teacher_code, via }
exports.join = asyncHandler(async (req, res) => {
  const s = _student(req);
  const t = await _teacher(req.body?.teacher_code);
  if (!t) throw new AppError('हा teacher code सापडला नाही', 404);
  // The teacher gave the link / code himself, so the student joins at once (owner's choice).
  if (!(t.assigned_students || []).includes(s.student_code)) {
    await TeacherJoinRequest.updateOne(
      { teacher_code: t.teacher_code, student_code: s.student_code },
      { $set: { student_name: s.name, class: (s.assigned_batches || [])[0] || '', via: req.body?.via === 'code' ? 'code' : 'link', status: 'accepted', decided_at: new Date() } },
      { upsert: true },
    );
    await _link(t, s.student_code);
  }
  res.json({ success: true, status: 'accepted', teacher: { code: t.teacher_code, name: t.name, institute: t.institute_name || '' } });
});

// GET /api/teacher-connect/mine — my teachers
exports.mine = asyncHandler(async (req, res) => {
  const s = _student(req);
  const linked = await User.find({ role: 'teacher', assigned_students: s.student_code }).select('teacher_code name institute_name partner_type').lean();
  res.json({
    success: true,
    data: { teachers: linked.filter(t => !t.partner_type || t.partner_type === 'school').map(t => ({ code: t.teacher_code, name: t.name, institute: t.institute_name || '' })) },
  });
});
