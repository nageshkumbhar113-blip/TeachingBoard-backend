const StudyPlan = require('../models/StudyPlan');
const StudyTask = require('../models/StudyTask');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const sp = require('../utils/studyPlan');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function serializePlan(plan) {
  return {
    id: String(plan._id),
    examName: plan.examName,
    startDate: sp.dateToStr(plan.startDate),
    targetDate: sp.dateToStr(plan.targetDate),
    offDaysOfWeek: plan.offDaysOfWeek,
    revisionSharePercent: plan.revisionSharePercent,
    subjects: plan.subjects.map(s => ({ subjectId: s.subjectId, chapterIds: s.chapterIds, totalItems: s.totalItems })),
    totalItemsOverall: plan.totalItemsOverall,
    maxItemsPerDay: plan.maxItemsPerDay,
    maxNotesPerDay: plan.maxNotesPerDay,
    maxPassagesPerDay: plan.maxPassagesPerDay,
    maxMcqPerDay: plan.maxMcqPerDay,
    status: plan.status,
  };
}

function serializeTask(t) {
  return {
    id: String(t._id), date: t.date, subjectId: t.subjectId, chapterId: t.chapterId, chapterName: t.chapterName,
    itemType: t.itemType, refId: t.refId, label: t.label, sequence: t.sequence, status: t.status, completedAt: t.completedAt,
  };
}

async function _activePlan(studentUserId) {
  return StudyPlan.findOne({ studentUserId, status: 'active' });
}

// POST /api/study-plan  { examName, targetDate:'YYYY-MM-DD', offDaysOfWeek?:[0-6], revisionSharePercent?, subjects:[{subjectId, chapterIds?:[]}], force? }
exports.createPlan = asyncHandler(async (req, res) => {
  const s = req.userDoc;
  const examName = String(req.body.examName || '').trim().slice(0, 100);
  const targetDate = String(req.body.targetDate || '').trim();
  if (!examName) throw new AppError('examName is required', 400);
  if (!DATE_RE.test(targetDate)) throw new AppError('targetDate must look like 2026-12-31', 400);
  const subjects = Array.isArray(req.body.subjects) ? req.body.subjects : [];
  if (!subjects.length) throw new AppError('Choose at least one subject', 400);
  for (const sub of subjects) {
    if (!sub || !String(sub.subjectId || '').trim()) throw new AppError('Every subject needs a subjectId', 400);
    if (sub.chapterIds !== undefined && !Array.isArray(sub.chapterIds)) throw new AppError('chapterIds must be an array', 400);
  }
  const offDaysOfWeek = Array.isArray(req.body.offDaysOfWeek) ? req.body.offDaysOfWeek.map(Number).filter(n => n >= 0 && n <= 6) : [];
  const revisionSharePercent = req.body.revisionSharePercent !== undefined ? Number(req.body.revisionSharePercent) : 15;
  if (!(revisionSharePercent >= 0 && revisionSharePercent <= 50)) throw new AppError('revisionSharePercent must be between 0 and 50', 400);
  const maxItemsPerDay = req.body.maxItemsPerDay !== undefined ? Number(req.body.maxItemsPerDay) : sp.DEFAULT_MAX_ITEMS_PER_DAY;
  if (!(maxItemsPerDay >= 1 && maxItemsPerDay <= 10)) throw new AppError('maxItemsPerDay must be between 1 and 10', 400);
  const maxNotesPerDay = req.body.maxNotesPerDay !== undefined ? Number(req.body.maxNotesPerDay) : sp.DEFAULT_MAX_NOTES_PER_DAY;
  if (!(maxNotesPerDay >= 1 && maxNotesPerDay <= 20)) throw new AppError('maxNotesPerDay must be between 1 and 20', 400);
  const maxPassagesPerDay = req.body.maxPassagesPerDay !== undefined ? Number(req.body.maxPassagesPerDay) : sp.DEFAULT_MAX_PASSAGES_PER_DAY;
  if (!(maxPassagesPerDay >= 1 && maxPassagesPerDay <= 10)) throw new AppError('maxPassagesPerDay must be between 1 and 10', 400);
  const maxMcqPerDay = req.body.maxMcqPerDay !== undefined ? Number(req.body.maxMcqPerDay) : sp.DEFAULT_MAX_MCQ_PER_DAY;
  if (!(maxMcqPerDay >= 1 && maxMcqPerDay <= 20)) throw new AppError('maxMcqPerDay must be between 1 and 20', 400);
  const batchId = Array.isArray(s.assigned_batches) ? s.assigned_batches[0] : '';
  if (!batchId) throw new AppError('No batch assigned to this account', 400);

  const result = await sp.createPlan({
    studentUserId: s.user_id, studentCode: s.student_code, batchId, examName, targetDateStr: targetDate,
    offDaysOfWeek, revisionSharePercent, maxItemsPerDay, maxNotesPerDay, maxPassagesPerDay, maxMcqPerDay,
    subjects: subjects.map(x => ({ subjectId: String(x.subjectId).trim(), chapterIds: x.chapterIds || [] })),
    force: req.body.force === true,
  });
  if (result.error) throw new AppError(result.error, 400);
  if (result.warning) return res.status(200).json({ success: true, warning: true, message: result.message, details: result.details });

  const tasks = await StudyTask.find({ studyPlanId: result.plan._id, date: sp.todayStr() }).sort({ sequence: 1 }).lean();
  res.status(201).json({ success: true, data: { plan: serializePlan(result.plan), today: tasks.map(serializeTask) } });
});

// GET /api/study-plan/me
exports.getMyPlan = asyncHandler(async (req, res) => {
  const plan = await _activePlan(req.userDoc.user_id);
  if (!plan) return res.json({ success: true, data: null });
  const progress = await sp.getProgress(plan);
  res.json({ success: true, data: { plan: serializePlan(plan), progress } });
});

// GET /api/study-plan/me/today
exports.getMyToday = asyncHandler(async (req, res) => {
  const plan = await _activePlan(req.userDoc.user_id);
  if (!plan) return res.json({ success: true, data: { plan: null, tasks: [] } });
  const tasks = await sp.getTodayTasks(plan);
  res.json({ success: true, data: { plan: serializePlan(plan), tasks: tasks.map(serializeTask) } });
});

// PATCH /api/study-plan/me/tasks/:id  { status: 'completed' | 'skipped' | 'pending' }
exports.updateTask = asyncHandler(async (req, res) => {
  const status = String(req.body.status || '').trim();
  if (!['completed', 'skipped', 'pending'].includes(status)) throw new AppError('status must be completed, skipped or pending', 400);
  const task = await StudyTask.findOne({ _id: req.params.id, studentUserId: req.userDoc.user_id });
  if (!task) throw new AppError('Task not found', 404);
  task.status = status;
  task.completedAt = status === 'completed' ? new Date() : null;
  await task.save();
  res.json({ success: true, data: serializeTask(task) });
});

// DELETE /api/study-plan/me — abandon the current plan (its history/tasks stay, just not active)
exports.abandonPlan = asyncHandler(async (req, res) => {
  const plan = await _activePlan(req.userDoc.user_id);
  if (!plan) return res.json({ success: true, message: 'No active plan' });
  plan.status = 'abandoned';
  await plan.save();
  res.json({ success: true, message: 'Plan ended' });
});

// GET /api/study-plan/teacher/summary — one row per assigned student who has an active plan
// (a lightweight weekly-digest source; the actual push is sent by jobs/notificationScheduler.js).
exports.getTeacherSummary = asyncHandler(async (req, res) => {
  const codes = Array.isArray(req.userDoc?.assigned_students) ? req.userDoc.assigned_students : [];
  if (!codes.length) return res.json({ success: true, data: [] });
  const plans = await StudyPlan.find({ studentCode: { $in: codes }, status: 'active' });
  const rows = [];
  for (const plan of plans) {
    const progress = await sp.getProgress(plan);
    rows.push({ studentCode: plan.studentCode, examName: plan.examName, overallPercent: progress.overallPercent, onTrack: progress.onTrack.status, examCountdownDays: progress.examCountdownDays });
  }
  res.json({ success: true, data: rows });
});
