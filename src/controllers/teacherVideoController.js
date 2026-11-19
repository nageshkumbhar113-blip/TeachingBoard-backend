// 🎬 A school teacher's own YouTube videos, only for that teacher's students (owner 2026-11-19).
// Teacher: add / edit / hide / delete in the Teacher app's "Videos" tab. Student: the videos of their own
// teachers — on Home ("माझ्या सरांचे Videos") and next to the Exercise / Notes concept / Test a video sits on.
// Admin: sees every video, can remove one. No approval step: a video never reaches another teacher's students.
const TeacherVideo = require('../models/TeacherVideo');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { sendToMany } = require('../utils/fcm');
const { parentTokensFor } = require('../utils/parentTokens');
const { extractVideoId } = require('./youtubeTeacherController');

const MAX_PER_TEACHER = 1000;
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const up = s => String(s || '').trim().toUpperCase();

function view(v, { teacher = false } = {}) {
  return {
    id: String(v._id),
    title: v.title,
    video_id: v.video_id,
    batch: v.batch || '',
    subject: v.subject || '', chapter: v.chapter || '',
    exercise_no: v.exercise_no || '', concept_id: v.concept_id || '', concept_title: v.concept_title || '',
    quiz_id: v.quiz_id || '', quiz_title: v.quiz_title || '',
    teacher_name: v.teacher_name || '',
    created_at: v.created_at,
    ...(teacher ? { hidden: !!v.hidden, removed_by_admin: !!v.removed_by_admin, open_count: v.open_count || 0, viewers: (v.viewers || []).length } : {}),
  };
}

// the fields a teacher sends (add / edit) → a clean document
function _fields(body, teacher) {
  const video_id = extractVideoId(body.url || body.video_id);
  if (!video_id) throw new AppError('YouTube video ची link बरोबर नाही (उदा. https://youtu.be/…)', 400);
  const title = str(body.title, 120);
  if (!title) throw new AppError('Video चं नाव लिहा', 400);
  const batch = str(body.batch, 120);
  const myBatches = new Set(teacher._batches || []);
  if (batch && !myBatches.has(batch)) throw new AppError('हा batch तुमच्या students मध्ये नाही', 400);
  const f = {
    title, video_id, batch,
    subject: str(body.subject, 120), chapter: str(body.chapter, 200),
    exercise_no: str(body.exercise_no, 40), concept_id: str(body.concept_id, 40), concept_title: str(body.concept_title, 200),
    quiz_id: str(body.quiz_id, 80), quiz_title: str(body.quiz_title, 200),
  };
  // one place only: an Exercise, a Notes concept or a Test (they need a chapter, a Test needs only its id)
  if ([f.exercise_no, f.concept_id, f.quiz_id].filter(Boolean).length > 1) throw new AppError('Exercise, Notes किंवा Test — यापैकी एकच निवडा', 400);
  if ((f.exercise_no || f.concept_id) && !(batch && f.subject && f.chapter)) throw new AppError('Exercise / Notes साठी batch, विषय आणि धडा निवडा', 400);
  if (!f.chapter) f.subject = f.subject && batch ? f.subject : '';
  return f;
}

// the teacher, with the batches of their own students (what they may pick from)
async function _teacher(req) {
  const t = req.userDoc;
  if (!t || t.role !== 'teacher') throw new AppError('Teacher access required', 403);
  const codes = (t.assigned_students || []).map(up);
  const students = codes.length ? await User.find({ role: 'student', student_code: { $in: codes } }, 'student_code assigned_batches').lean() : [];
  const batches = [...new Set(students.flatMap(s => s.assigned_batches || []))].sort();
  return { ...t, _codes: codes, _batches: batches };
}

// the students (and their parents) who see this video → a push "new video"
async function _notify(teacher, v) {
  try {
    let codes = teacher._codes;
    if (v.batch) {
      const inBatch = await User.find({ role: 'student', student_code: { $in: codes }, assigned_batches: v.batch }, 'student_code').lean();
      codes = inBatch.map(s => s.student_code);
    }
    if (!codes.length) return 0;
    const kids = await User.find({ role: 'student', student_code: { $in: codes }, device_token: { $exists: true, $nin: [null, ''] } }, 'device_token').lean();
    const tokens = [...new Set([...kids.map(k => k.device_token), ...await parentTokensFor(codes)].filter(Boolean))];
    if (!tokens.length) return 0;
    await sendToMany(tokens, `🎬 ${teacher.name || 'तुमच्या सरांनी'} नवीन video टाकला`, v.title, { type: 'teacher_video', video_id: String(v._id) }).catch(() => {});
    return codes.length;
  } catch { return 0; }
}

// ── Teacher ──────────────────────────────────────────────────────────────────

// GET /api/teacher-videos/mine — my videos + the batches I may choose
exports.listMine = asyncHandler(async (req, res) => {
  const t = await _teacher(req);
  const list = await TeacherVideo.find({ teacher_id: t.user_id }).sort({ created_at: -1 }).limit(MAX_PER_TEACHER).lean();
  res.json({ success: true, data: { videos: list.map(v => view(v, { teacher: true })), batches: t._batches, students: t._codes.length } });
});

// POST /api/teacher-videos/mine — add (notify: true → a push to the students and parents)
exports.create = asyncHandler(async (req, res) => {
  const t = await _teacher(req);
  if (await TeacherVideo.countDocuments({ teacher_id: t.user_id }) >= MAX_PER_TEACHER) throw new AppError(`जास्तीत जास्त ${MAX_PER_TEACHER} videos`, 400);
  const f = _fields(req.body || {}, t);
  const v = await TeacherVideo.create({ ...f, teacher_id: t.user_id, teacher_code: t.teacher_code || '', teacher_name: t.name || '' });
  const notified = req.body?.notify === false ? 0 : await _notify(t, v);
  res.status(201).json({ success: true, data: view(v.toObject(), { teacher: true }), notified });
});

// PUT /api/teacher-videos/mine/:id — edit, or { hidden: true|false } alone to hide / show
exports.update = asyncHandler(async (req, res) => {
  const t = await _teacher(req);
  const v = await TeacherVideo.findOne({ _id: req.params.id, teacher_id: t.user_id });
  if (!v) throw new AppError('Video सापडला नाही', 404);
  const b = req.body || {};
  const onlyHide = Object.keys(b).length === 1 && b.hidden !== undefined;
  if (onlyHide) v.hidden = b.hidden === true;
  else { Object.assign(v, _fields(b, t)); if (b.hidden !== undefined) v.hidden = b.hidden === true; }
  await v.save();
  res.json({ success: true, data: view(v.toObject(), { teacher: true }) });
});

// DELETE /api/teacher-videos/mine/:id
exports.remove = asyncHandler(async (req, res) => {
  const t = await _teacher(req);
  const r = await TeacherVideo.deleteOne({ _id: req.params.id, teacher_id: t.user_id });
  if (!r.deletedCount) throw new AppError('Video सापडला नाही', 404);
  res.json({ success: true });
});

// ── Student ──────────────────────────────────────────────────────────────────

// the videos this student may see: their teachers', for all students or for one of the student's batches
async function visibleFor(student, extra = {}) {
  const code = up(student?.student_code);
  if (!code) return [];
  const teachers = await User.find({ role: 'teacher', assigned_students: code, status: { $ne: 'blocked' } }, 'user_id').lean();
  if (!teachers.length) return [];
  const batches = student.assigned_batches || [];
  return TeacherVideo.find({
    teacher_id: { $in: teachers.map(t => t.user_id) }, hidden: false, removed_by_admin: false,
    $or: [{ batch: '' }, { batch: { $in: batches } }], ...extra,
  }).sort({ created_at: -1 }).limit(300).lean();
}
exports.visibleFor = visibleFor;

// GET /api/teacher-videos/for-me — all my teachers' videos (the Home list)
exports.forMe = asyncHandler(async (req, res) => {
  const list = await visibleFor(req.userDoc);
  res.json({ success: true, data: list.map(v => view(v)) });
});

// POST /api/teacher-videos/open/:id — "opened" (count + who), only for a video this student may see
exports.open = asyncHandler(async (req, res) => {
  const code = up(req.userDoc?.student_code);
  const ok = (await visibleFor(req.userDoc, { _id: req.params.id })).length;
  if (ok) await TeacherVideo.updateOne({ _id: req.params.id }, { $inc: { open_count: 1 }, ...(code ? { $addToSet: { viewers: code } } : {}) });
  res.json({ success: true });
});

// ── Admin ────────────────────────────────────────────────────────────────────

// GET /api/teacher-videos/admin?q= — every teacher's videos (newest first)
exports.adminList = asyncHandler(async (req, res) => {
  const q = str(req.query.q, 60);
  const re = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  const list = await TeacherVideo.find(re ? { $or: [{ title: re }, { teacher_name: re }, { teacher_code: re }] } : {}).sort({ created_at: -1 }).limit(300).lean();
  res.json({ success: true, data: list.map(v => ({ ...view(v, { teacher: true }), teacher_code: v.teacher_code })) });
});

// POST /api/teacher-videos/admin/:id/remove  { removed: true|false } — take a video off the students' side
exports.adminRemove = asyncHandler(async (req, res) => {
  const removed = req.body?.removed !== false;
  const r = await TeacherVideo.updateOne({ _id: req.params.id }, { $set: { removed_by_admin: removed } });
  if (!r.matchedCount) throw new AppError('Video सापडला नाही', 404);
  res.json({ success: true, removed });
});
