const User = require('../models/User');
const PracticePaper = require('../models/PracticePaper');
const PaperQuotaConfig = require('../models/PaperQuotaConfig');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { getConfig, getQuota } = require('../utils/paperQuota');
const { invalidateUserCache } = require('../middleware/auth');

// GET /api/teacher/paper-quota?batch=  — the logged-in teacher's own quota
exports.getMyPaperQuota = asyncHandler(async (req, res) => {
  const batch = String(req.query.batch || '').trim();
  const config = await getConfig();
  if (!batch) {
    return res.json({ success: true, data: { free_papers: config.free_papers, unlock_paid_students: config.unlock_paid_students } });
  }
  const quota = await getQuota(req.userDoc, batch, config);
  res.json({ success: true, data: quota });
});

// GET /api/teachers/paper-quota/config
exports.getQuotaConfig = asyncHandler(async (_req, res) => {
  const c = await getConfig();
  res.json({ success: true, data: { free_papers: c.free_papers, unlock_paid_students: c.unlock_paid_students, effective_from: c.effective_from } });
});

// PUT /api/teachers/paper-quota/config  { free_papers, unlock_paid_students }
exports.setQuotaConfig = asyncHandler(async (req, res) => {
  const update = {};
  if (req.body.free_papers !== undefined) {
    const n = Number(req.body.free_papers);
    if (!Number.isInteger(n) || n < 0) throw new AppError('free_papers must be a whole number 0 or more', 400);
    update.free_papers = n;
  }
  if (req.body.unlock_paid_students !== undefined) {
    const n = Number(req.body.unlock_paid_students);
    if (!Number.isInteger(n) || n < 1) throw new AppError('unlock_paid_students must be a whole number 1 or more', 400);
    update.unlock_paid_students = n;
  }
  await getConfig();
  const c = await PaperQuotaConfig.findOneAndUpdate({ key: 'default' }, { $set: update }, { new: true }).lean();
  res.json({ success: true, data: { free_papers: c.free_papers, unlock_paid_students: c.unlock_paid_students, effective_from: c.effective_from } });
});

// GET /api/teachers/paper-quota — every teacher x batch with usage, for the admin table
exports.listQuotas = asyncHandler(async (_req, res) => {
  const config = await getConfig();
  const teachers = await User.find({ role: 'teacher' }).lean();
  const rows = [];

  for (const t of teachers) {
    const codes = (t.assigned_students || []).filter(Boolean);
    const [students, paperBatches] = await Promise.all([
      codes.length ? User.find({ role: 'student', student_code: { $in: codes } }, 'assigned_batches').lean() : [],
      PracticePaper.distinct('batchId', { createdBy: t.user_id }),
    ]);
    const batches = new Set(paperBatches.filter(Boolean));
    students.forEach(s => (s.assigned_batches || []).forEach(b => b && batches.add(b)));

    for (const batch of [...batches].sort()) {
      const q = await getQuota(t, batch, config);
      rows.push({ teacher_id: t.user_id, teacher_code: t.teacher_code, teacher_name: t.name, ...q });
    }
    // Batch-less overall override row so admins can see/clear a '*' override
    const star = (t.paper_quota_overrides || []).find(o => o.batch === '*');
    if (star) rows.push({ teacher_id: t.user_id, teacher_code: t.teacher_code, teacher_name: t.name, batch: '*', override: star.mode, used: null, paid: null });
  }

  res.json({ success: true, data: { config: { free_papers: config.free_papers, unlock_paid_students: config.unlock_paid_students }, rows } });
});

// PUT /api/teachers/:id/paper-quota-override
// { batch: 'name' | '*', mode: 'unlimited' | 'custom' | 'default', free_papers?, unlock_paid_students? }
exports.setOverride = asyncHandler(async (req, res) => {
  const batch = String(req.body.batch || '').trim();
  const mode = String(req.body.mode || '').trim();
  if (!batch) throw new AppError('batch is required (or "*" for all batches)', 400);
  if (!['unlimited', 'custom', 'default'].includes(mode)) throw new AppError('mode must be unlimited, custom or default', 400);

  const teacher = await User.findOne({ user_id: req.params.id, role: 'teacher' });
  if (!teacher) throw new AppError('Teacher not found', 404);

  const rest = (teacher.paper_quota_overrides || []).filter(o => o.batch !== batch).map(o => o.toObject());
  if (mode !== 'default') {
    const entry = { batch, mode };
    if (mode === 'custom') {
      if (req.body.free_papers !== undefined && req.body.free_papers !== null && req.body.free_papers !== '') {
        const n = Number(req.body.free_papers);
        if (!Number.isInteger(n) || n < 0) throw new AppError('free_papers must be a whole number 0 or more', 400);
        entry.free_papers = n;
      }
      if (req.body.unlock_paid_students !== undefined && req.body.unlock_paid_students !== null && req.body.unlock_paid_students !== '') {
        const n = Number(req.body.unlock_paid_students);
        if (!Number.isInteger(n) || n < 1) throw new AppError('unlock_paid_students must be a whole number 1 or more', 400);
        entry.unlock_paid_students = n;
      }
      if (entry.free_papers === undefined && entry.unlock_paid_students === undefined) {
        throw new AppError('custom needs free_papers and/or unlock_paid_students', 400);
      }
    }
    rest.push(entry);
  }
  teacher.paper_quota_overrides = rest;
  await teacher.save();
  invalidateUserCache('teacher', teacher.user_id);

  res.json({ success: true, data: { overrides: teacher.paper_quota_overrides } });
});
