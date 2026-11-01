const Batch = require('../models/Batch');
const WeeklySchedule = require('../models/WeeklySchedule');
const WeeklyEvent = require('../models/WeeklyEvent');
const WeeklyEntry = require('../models/WeeklyEntry');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { hasFullAccess } = require('../utils/contentAccess');
const W = require('../utils/weeklyTests');

// महा-Test (weekly automatic test). Student / free-visitor endpoints are all
// tiny except the paper download, which phones do ahead of time.

const SUBMIT_GRACE_MS = 15 * 60 * 1000;   // a submit queued offline may arrive a little late
const _now = () => new Date();

function _me(req) {
  if (req.user?.role !== 'student' || !req.userDoc) throw new AppError('Login required', 401);
  return {
    code: req.user.student_code || req.userDoc.student_code,
    name: req.userDoc.name || req.user.name || '',
    guest: !!req.user.guest,
    batches: Array.isArray(req.userDoc.assigned_batches) ? req.userDoc.assigned_batches : [],
    full: hasFullAccess(req.userDoc),
  };
}

async function _eventFor(req, me, { withKey = false } = {}) {
  const q = WeeklyEvent.findById(req.params.id);
  if (withKey) q.select('+key_b64');
  const ev = await q.catch(() => null);
  if (!ev || ev.status === 'skipped' || !me.batches.includes(ev.batch)) throw new AppError('Test not found', 404);
  if (ev.open_to === 'paid' && !me.full) throw new AppError('हा महा-Test subscription असलेल्यांसाठी आहे', 403);
  return ev;
}

function _view(ev, entry, registered = 0, now = _now()) {
  const state = now < ev.starts_at ? 'upcoming' : now < ev.ends_at ? 'live' : 'closed';
  const reveal = W.revealOf(ev);
  return {
    event_id: String(ev._id), batch: ev.batch, subject: ev.subject, title: ev.title,
    starts_at: ev.starts_at, ends_at: ev.ends_at, reveal_at: reveal, duration_minutes: ev.duration_minutes,
    question_count: ev.questions?.length || 0, open_to: ev.open_to, state,
    results: now >= reveal,
    registered_count: registered,
    me: entry ? {
      registered: true, submitted: !!entry.submitted_at, score: entry.submitted_at ? entry.score : null,
      total: entry.total || null, rank: entry.rank ?? null,
    } : { registered: false, submitted: false },
  };
}

// GET /api/weekly/my — this week's test (and last week's, for its result).
exports.my = asyncHandler(async (req, res) => {
  const me = _me(req);
  const since = new Date(Date.now() - 7 * 864e5);
  const events = await WeeklyEvent.find({ batch: { $in: me.batches }, status: { $ne: 'skipped' }, ends_at: { $gt: since }, is_trial: { $ne: true } })
    .select('-questions.answer -questions.explanation').sort({ starts_at: 1 }).limit(10).lean();
  // trial events (admin "try now") are shown too, so the admin can test on a phone
  const trials = await WeeklyEvent.find({ batch: { $in: me.batches }, is_trial: true, ends_at: { $gt: new Date(Date.now() - 864e5) } }).select('-questions.answer -questions.explanation').lean();
  const all = [...events, ...trials];
  const entries = await WeeklyEntry.find({ event_id: { $in: all.map(e => String(e._id)) }, student_code: me.code }).lean();
  const byEvent = new Map(entries.map(e => [e.event_id, e]));
  const counts = await WeeklyEntry.aggregate([{ $match: { event_id: { $in: all.map(e => String(e._id)) } } }, { $group: { _id: '$event_id', n: { $sum: 1 } } }]);
  const countBy = new Map(counts.map(c => [c._id, c.n]));
  const data = all.filter(e => e.open_to !== 'paid' || me.full).map(e => _view(e, byEvent.get(String(e._id)), countBy.get(String(e._id)) || 0));
  res.json({ success: true, data });
});

// POST /api/weekly/:id/register
exports.register = asyncHandler(async (req, res) => {
  const me = _me(req);
  const ev = await _eventFor(req, me);
  if (_now() >= ev.ends_at) throw new AppError('हा महा-Test संपला', 400);
  await WeeklyEntry.updateOne(
    { event_id: String(ev._id), student_code: me.code },
    { $setOnInsert: { name: me.name, is_guest: me.guest, registered_at: _now() } },
    { upsert: true }
  );
  res.json({ success: true });
});

// GET /api/weekly/:id/paper — encrypted questions (no answers), any time before the end.
exports.paper = asyncHandler(async (req, res) => {
  const me = _me(req);
  const ev = await _eventFor(req, me, { withKey: true });
  if (_now() >= ev.ends_at) throw new AppError('हा महा-Test संपला', 400);
  res.set('Cache-Control', 'private, max-age=3600');
  res.json({ success: true, data: { event_id: String(ev._id), duration_minutes: ev.duration_minutes, starts_at: ev.starts_at, ends_at: ev.ends_at, ...W.encryptPaper(ev) } });
});

// GET /api/weekly/:id/key — only once the test has started (~50 bytes).
exports.key = asyncHandler(async (req, res) => {
  const me = _me(req);
  const ev = await _eventFor(req, me, { withKey: true });
  const now = _now();
  if (now < ev.starts_at) return res.status(425).json({ success: false, code: 'NOT_YET', starts_at: ev.starts_at });
  if (now >= ev.ends_at) throw new AppError('हा महा-Test संपला', 400);
  res.json({ success: true, key: ev.key_b64 });
});

// POST /api/weekly/:id/submit { answers:[{q_id, given}], time_taken, leave_count }
exports.submit = asyncHandler(async (req, res) => {
  const me = _me(req);
  const ev = await _eventFor(req, me);
  const now = _now();
  if (now < ev.starts_at) throw new AppError('Test अजून सुरू झाला नाही', 400);
  // a submit queued offline may come a little late, but never after the rank list is out
  const cutoff = Math.min(ev.ends_at.getTime() + SUBMIT_GRACE_MS, Math.max(W.revealOf(ev).getTime(), ev.ends_at.getTime()));
  if (now.getTime() > cutoff) throw new AppError('वेळ संपली — हा test जमा करता येणार नाही', 400);
  const existing = await WeeklyEntry.findOne({ event_id: String(ev._id), student_code: me.code }).lean();
  if (existing?.submitted_at) {
    return res.json({ success: true, already: true, data: { score: existing.score, total: existing.total, correct: existing.correct, wrong: existing.wrong, skipped: existing.skipped } });
  }
  const g = W.grade(ev, Array.isArray(req.body?.answers) ? req.body.answers.slice(0, 200) : []);
  const maxSec = ev.duration_minutes * 60;
  const timeTaken = Math.min(maxSec, Math.max(0, Math.round(Number(req.body?.time_taken) || maxSec)));
  await WeeklyEntry.updateOne(
    { event_id: String(ev._id), student_code: me.code },
    { $set: { submitted_at: now, answers: g.answers, score: g.score, total: g.total, correct: g.correct, wrong: g.wrong, skipped: g.skipped,
      time_taken: timeTaken, leave_count: Math.max(0, Number(req.body?.leave_count) || 0), name: me.name, is_guest: me.guest },
      $setOnInsert: { registered_at: now } },
    { upsert: true }
  );
  res.json({ success: true, data: { score: g.score, total: g.total, correct: g.correct, wrong: g.wrong, skipped: g.skipped } });
});

// GET /api/weekly/:id/result — after the window: rank, top 10, answer key.
exports.result = asyncHandler(async (req, res) => {
  const me = _me(req);
  let ev = await _eventFor(req, me);
  if (_now() < W.revealOf(ev)) return res.json({ success: true, pending: true, reveal_at: W.revealOf(ev) });
  ev = await W.finalizeIfDue(ev);
  const mine = await WeeklyEntry.findOne({ event_id: String(ev._id), student_code: me.code }).lean();
  // Rank board: the top 50 (first names only); the student's own row is added below if outside it.
  const top = await WeeklyEntry.find({ event_id: String(ev._id), submitted_at: { $ne: null } }).sort({ rank: 1, score: -1 }).limit(50).select('name score total rank time_taken student_code').lean();
  const given = new Map((mine?.answers || []).map(a => [a.q_id, a.given]));
  res.json({
    success: true,
    data: {
      event_id: String(ev._id), subject: ev.subject, participants: ev.participants,
      me: mine?.submitted_at ? { score: mine.score, total: mine.total, correct: mine.correct, wrong: mine.wrong, skipped: mine.skipped, rank: mine.rank, time_taken: mine.time_taken } : null,
      top: top.map(t => ({ name: String(t.name || '').split(/\s+/)[0] || 'Student', score: t.score, total: t.total, rank: t.rank, me: t.student_code === me.code })),
      review: ev.questions.map(q => ({ q_id: q.q_id, type: q.type, question: q.question, options: q.options, answer: q.answer, explanation: q.explanation, image: q.image, given: given.get(q.q_id) || '' })),
    },
  });
});

// ── Admin ────────────────────────────────────────────────────────────────────

const _ALLOWED = ['batch', 'title', 'enabled', 'day_of_week', 'start_time', 'result_time', 'window_minutes', 'duration_minutes', 'question_count', 'question_types', 'question_source', 'subjects', 'open_to'];
function _pick(body) {
  const out = {};
  for (const k of _ALLOWED) if (body?.[k] !== undefined) out[k] = body[k];
  if (out.question_types) out.question_types = [].concat(out.question_types).filter(t => ['mcq', 'tf', 'fib'].includes(t));
  if (out.subjects) out.subjects = [].concat(out.subjects).map(s => String(s).trim()).filter(Boolean);
  return out;
}

exports.adminSchedules = asyncHandler(async (_req, res) => {
  const schedules = await WeeklySchedule.find({}).sort({ batch: 1 }).lean();
  const next = await WeeklyEvent.find({ schedule_id: { $in: schedules.map(s => String(s._id)) }, ends_at: { $gt: new Date() }, is_trial: { $ne: true } }).select('schedule_id subject starts_at ends_at reveal_at status questions.q_id').lean();
  const nextBy = new Map(next.map(e => [e.schedule_id, { subject: e.subject, starts_at: e.starts_at, ends_at: e.ends_at, reveal_at: W.revealOf(e), status: e.status, questions: e.questions?.length || 0 }]));
  res.json({ success: true, data: schedules.map(s => ({ ...s, next: nextBy.get(String(s._id)) || null })) });
});

exports.adminSaveSchedule = asyncHandler(async (req, res) => {
  const body = _pick(req.body);
  if (!req.params.id) {
    if (!body.batch || !(await Batch.exists({ name: body.batch }))) throw new AppError('Class निवडा', 400);
  }
  const s = req.params.id
    ? await WeeklySchedule.findByIdAndUpdate(req.params.id, { $set: body }, { new: true, runValidators: true }).catch(() => null)
    : await WeeklySchedule.create(body);
  if (!s) throw new AppError('Not found', 404);
  // timing / content changed → the not-yet-started event is made again with the new settings
  await WeeklyEvent.deleteMany({ schedule_id: String(s._id), is_trial: { $ne: true }, starts_at: { $gt: new Date() } });
  if (s.enabled) await W.ensureUpcoming();
  res.status(req.params.id ? 200 : 201).json({ success: true, data: s });
});

exports.adminDeleteSchedule = asyncHandler(async (req, res) => {
  const s = await WeeklySchedule.findByIdAndDelete(req.params.id).catch(() => null);
  if (!s) throw new AppError('Not found', 404);
  // its future tests and every trial go with it; finished real tests (with results) stay
  const gone = await WeeklyEvent.find({ schedule_id: String(s._id), $or: [{ starts_at: { $gt: new Date() } }, { is_trial: true }] }, '_id').lean();
  await WeeklyEntry.deleteMany({ event_id: { $in: gone.map(e => String(e._id)) } });
  await WeeklyEvent.deleteMany({ _id: { $in: gone.map(e => e._id) } });
  res.json({ success: true });
});

// POST /api/weekly/admin/schedules/:id/trial { start_in_minutes, window_minutes } — try it now.
exports.adminTrial = asyncHandler(async (req, res) => {
  const s = await WeeklySchedule.findById(req.params.id).lean().catch(() => null);
  if (!s) throw new AppError('Not found', 404);
  // one trial at a time: pressing the button again returns the running one
  const running = await WeeklyEvent.findOne({ schedule_id: String(s._id), is_trial: true, ends_at: { $gt: new Date() } }).lean();
  if (running) {
    return res.json({ success: true, existing: true, data: { event_id: String(running._id), subject: running.subject, starts_at: running.starts_at, ends_at: running.ends_at, questions: running.questions.length } });
  }
  const raw = Number(req.body?.start_in_minutes);
  const startIn = Math.min(Math.max(Number.isFinite(raw) ? raw : 2, 0), 120);
  const windowMin = Math.min(Math.max(Number(req.body?.window_minutes) || 30, 10), 240);
  const ev = await W.generateEvent({ ...s, window_minutes: windowMin }, new Date(Date.now() + startIn * 60000), { trial: true });
  if (!ev) throw new AppError('या class ला विषय नाहीत', 400);
  if (ev.status === 'skipped') throw new AppError(ev.skip_reason, 400);
  res.status(201).json({ success: true, data: { event_id: String(ev._id), subject: ev.subject, starts_at: ev.starts_at, ends_at: ev.ends_at, questions: ev.questions.length } });
});

// DELETE /api/weekly/admin/events/:id — remove one test (e.g. trials) and its entries.
exports.adminDeleteEvent = asyncHandler(async (req, res) => {
  const ev = await WeeklyEvent.findByIdAndDelete(req.params.id).catch(() => null);
  if (!ev) throw new AppError('Not found', 404);
  await WeeklyEntry.deleteMany({ event_id: String(ev._id) });
  res.json({ success: true });
});

// GET /api/weekly/admin/pool?batch=&types=mcq,tf&source=both — how many questions each subject has.
exports.adminPool = asyncHandler(async (req, res) => {
  const batch = String(req.query.batch || '');
  const b = await Batch.findOne({ name: batch }, 'subjects.name').lean();
  if (!b) throw new AppError('Class निवडा', 400);
  const types = String(req.query.types || 'mcq').split(',');
  const source = ['bank', 'tests', 'both'].includes(req.query.source) ? req.query.source : 'both';
  const data = [];
  for (const s of b.subjects || []) data.push({ subject: s.name, questions: (await W.questionPool(batch, s.name, types, source)).length });
  res.json({ success: true, data });
});

exports.adminEvents = asyncHandler(async (req, res) => {
  const filter = req.query.batch ? { batch: String(req.query.batch) } : {};
  const events = await WeeklyEvent.find(filter).sort({ starts_at: -1 }).limit(40).select('-questions').lean();
  const ids = events.map(e => String(e._id));
  const counts = await WeeklyEntry.aggregate([{ $match: { event_id: { $in: ids } } }, { $group: { _id: '$event_id', registered: { $sum: 1 }, submitted: { $sum: { $cond: [{ $ne: ['$submitted_at', null] }, 1, 0] } } } }]);
  const by = new Map(counts.map(c => [c._id, c]));
  res.json({ success: true, data: events.map(e => ({ ...e, registered: by.get(String(e._id))?.registered || 0, submitted: by.get(String(e._id))?.submitted || 0 })) });
});

exports.adminEventResults = asyncHandler(async (req, res) => {
  let ev = await WeeklyEvent.findById(req.params.id).catch(() => null);
  if (!ev) throw new AppError('Not found', 404);
  ev = await W.finalizeIfDue(ev);
  const entries = await WeeklyEntry.find({ event_id: String(ev._id) }).sort({ rank: 1, score: -1 }).select('-answers').lean();
  // mobile for follow-up: the parent's (free visitors) or the student's own
  const GuestLead = require('../models/GuestLead');
  const User = require('../models/User');
  const gids = entries.filter(e => e.is_guest).map(e => String(e.student_code).replace(/^GUEST-/, ''));
  const codes = entries.filter(e => !e.is_guest).map(e => e.student_code);
  const [leads, users] = await Promise.all([
    gids.length ? GuestLead.find({ gid: { $in: gids } }, 'gid parent_mobile').lean() : [],
    codes.length ? User.find({ role: 'student', student_code: { $in: codes } }, 'student_code mobile').lean() : [],
  ]);
  const mob = new Map([...leads.map(l => [`GUEST-${l.gid}`, l.parent_mobile]), ...users.map(u => [u.student_code, u.mobile])]);
  entries.forEach(e => { e.mobile = mob.get(e.student_code) || ''; });
  res.json({ success: true, data: { event: { _id: ev._id, batch: ev.batch, subject: ev.subject, starts_at: ev.starts_at, ends_at: ev.ends_at, status: ev.status }, entries } });
});
