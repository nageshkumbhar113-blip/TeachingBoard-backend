const Batch = require('../models/Batch');
const WeeklySchedule = require('../models/WeeklySchedule');
const WeeklyEvent = require('../models/WeeklyEvent');
const WeeklyEntry = require('../models/WeeklyEntry');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { hasFullAccess } = require('../utils/contentAccess');
const W = require('../utils/weeklyTests');
const User = require('../models/User');
const GuestLead = require('../models/GuestLead');
const PracticeDay = require('../models/PracticeDay');
const { invalidateUserCache } = require('../middleware/auth');

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
    full: hasFullAccess(req.userDoc) && !req.userDoc.demo_of_teacher,
    hide: req.userDoc.hide_in_toppers === true,
    demo: !!req.userDoc.demo_of_teacher,   // 🎯 a teacher's school demo student: no daily papers / महा-Test
  };
}

async function _eventFor(req, me, { withKey = false } = {}) {
  const q = WeeklyEvent.findById(req.params.id);
  if (withKey) q.select('+key_b64');
  const ev = await q.catch(() => null);
  if (!ev || ev.status === 'skipped' || !me.batches.includes(ev.batch)) throw new AppError('Test not found', 404);
  if (me.demo) throw new AppError('School demo विद्यार्थ्यासाठी हा पेपर नाही', 403);
  if (ev.open_to === 'paid' && !me.full) throw new AppError('हा महा-Test subscription असलेल्यांसाठी आहे', 403);
  return ev;
}

const HIDDEN_NAME = 'नाव लपवलेलं';
const _hm = d => new Date(new Date(d).getTime() + 5.5 * 3600e3).toISOString().slice(11, 16);

// Owner (2026-11-16): the rank board shows every child's name inside the app (no permission asked); on the website
// (student-app on the web, the public महा-Test page) names stay hidden. The installed app's WebView sends its own origin.
const APP_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost',
  ...String(process.env.APP_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)]);
const _isApp = req => APP_ORIGINS.has(String(req.headers.origin || ''));

// The child's family: this account + the free-part visits / accounts made with the same parent's number — so
// "the first महा-Test" is the family's first, wherever it was given.
async function _familyCodes(me) {
  const codes = new Set([me.code]);
  const leads = me.guest
    ? await GuestLead.find({ gid: me.code.replace(/^GUEST-/, '') }).select('gid parent_mobile converted_code').lean()
    : await GuestLead.find({ converted_code: me.code }).select('gid parent_mobile converted_code').limit(10).lean();
  const mobiles = [...new Set(leads.map(l => l.parent_mobile).filter(Boolean))];
  const all = mobiles.length ? [...leads, ...await GuestLead.find({ parent_mobile: { $in: mobiles } }).select('gid converted_code').limit(30).lean()] : leads;
  for (const l of all) { codes.add('GUEST-' + l.gid); if (l.converted_code) codes.add(l.converted_code); }
  return [...codes];
}
// a महा-Test this family submitted before `before` (other than `exceptId`; admin trials do not count)
async function _priorEntry(codes, before, exceptId = '') {
  const q = { student_code: { $in: codes }, submitted_at: { $ne: null, $lt: before } };
  if (exceptId) q.event_id = { $ne: exceptId };
  const rows = await WeeklyEntry.find(q).select('event_id').limit(20).lean();
  if (!rows.length) return false;
  return !!(await WeeklyEvent.exists({ _id: { $in: rows.map(r => r.event_id) }, is_trial: { $ne: true } }));
}
// On the website only the family's first महा-Test can be given; the next ones are in the app.
const APP_ONLY_MSG = '📲 पुढचे महा-Test फक्त NKs EduOrbit app मध्ये — app download करा, तिथेच महा-Test मिळेल.';
async function _webBlocked(req, me) {
  if (_isApp(req)) return false;
  return _priorEntry(await _familyCodes(me), _now());
}

function _view(ev, entry, registered = 0, now = _now(), bannerUntil = null, app = false, day = null) {
  const state = now < ev.starts_at ? 'upcoming' : now < ev.ends_at ? 'live' : 'closed';
  const reveal = W.revealOf(ev);
  const results = now >= reveal;
  const dayPaper = !!ev.day_key;
  const out = {
    event_id: String(ev._id), batch: ev.batch, subject: ev.subject, title: ev.title,
    starts_at: ev.starts_at, ends_at: ev.ends_at, reveal_at: reveal, duration_minutes: ev.duration_minutes,
    question_count: ev.questions?.length || 0, open_to: ev.open_to, state,
    paper_order: ev.paper_order || '', sections: (ev.sections || []).map(s => ({ subject: s.subject, count: s.count, marks: s.marks })), negative: ev.negative || 0,
    results,
    registered_count: registered,
    participants: ev.participants || 0,
    // Home banner: top 10 of this class until the next महा-Test starts. A day of papers (practice,
    // महा-Test with every paper on one day): only the day's last paper has a banner — the day total.
    toppers: !results ? [] : (dayPaper ? (ev.day_final ? ev.day_toppers || [] : []) : ev.toppers || [])
      .map(t => ({ rank: t.rank, name: app ? t.name : HIDDEN_NAME, score: t.score, total: t.total })),
    banner_until: results ? (ev.banner_until || bannerUntil || new Date(reveal.getTime() + 7 * 864e5)) : null,
    me: entry ? {
      registered: true, submitted: !!entry.submitted_at, score: entry.submitted_at ? entry.score : null,
      total: entry.total || null, rank: entry.rank ?? null,
    } : { registered: false, submitted: false },
    // practice: the paper can be started only till join_until; kind / day for the app (9.0.1+)
    kind: ev.kind || 'weekly', day_key: ev.day_key || '', day_final: !!ev.day_final, join_until: ev.join_until || null,
    day: day ? { score: day.score, total: day.total, rank: results && day.final ? day.rank : null, participants: day.participants, final: !!day.final,
      papers: (day.papers || []).map(x => ({ subject: x.subject, score: x.score, total: x.total, by_subject: x.by_subject || [] })) } : null,
  };
  // the day's last paper, after its result: the banner's "mine" card shows the day total and rank
  if (dayPaper && ev.day_final && results && day?.final) {
    out.participants = ev.day_participants || day.participants || out.participants;
    out.me = { registered: true, submitted: true, score: day.score, total: day.total, rank: day.rank, paper: out.me };
  }
  return out;
}

// GET /api/weekly/my — this week's test (and last week's, for its result).
let _lastEnsure = 0;
exports.my = asyncHandler(async (req, res) => {
  const me = _me(req);
  // the server may have been asleep at the scheduler's tick: make the coming papers now (at most once a minute)
  if (Date.now() - _lastEnsure > 60e3) { _lastEnsure = Date.now(); W.ensureUpcoming().catch(err => console.warn('weekly ensure (my) failed:', err.message)); }
  const since = new Date(Date.now() - 7 * 864e5);
  // newest 30 (a week of daily practice papers + the महा-Test), in time order; only the question count is needed
  const LIGHT = '-questions.question -questions.options -questions.answer -questions.explanation -questions.image -questions.option_images -questions.chapter';
  const events = (await WeeklyEvent.find({ batch: { $in: me.batches }, status: { $ne: 'skipped' }, ends_at: { $gt: since }, is_trial: { $ne: true } })
    .select(LIGHT).sort({ starts_at: -1 }).limit(30).lean()).reverse();
  // trial events (admin "try now") are shown too, so the admin can test on a phone
  const trials = await WeeklyEvent.find({ batch: { $in: me.batches }, is_trial: true, ends_at: { $gt: new Date(Date.now() - 864e5) } }).select(LIGHT).lean();
  const all = [...events, ...trials];
  // this child's day totals (practice / महा-Test days)
  const dayRows = await PracticeDay.find({ student_code: me.code, day_key: { $in: [...new Set(all.map(e => e.day_key).filter(Boolean))] } }).lean();
  const dayOf = e => e.day_key ? dayRows.find(d => d.schedule_id === e.schedule_id && d.day_key === e.day_key) || null : null;
  const entries = await WeeklyEntry.find({ event_id: { $in: all.map(e => String(e._id)) }, student_code: me.code }).lean();
  const byEvent = new Map(entries.map(e => [e.event_id, e]));
  const counts = await WeeklyEntry.aggregate([{ $match: { event_id: { $in: all.map(e => String(e._id)) } } }, { $group: { _id: '$event_id', n: { $sum: 1 } } }]);
  const countBy = new Map(counts.map(c => [c._id, c.n]));
  // the toppers banner of a class stays until that class's next महा-Test starts
  const nextOf = e => all.filter(x => x.schedule_id === e.schedule_id && !x.is_trial && x.starts_at > e.starts_at)
    .sort((a, b) => a.starts_at - b.starts_at)[0]?.starts_at || null;
  const now = _now();
  const app = _isApp(req);
  if (me.demo) return res.json({ success: true, data: [], consent: true, app_only: false, app_only_msg: '', locked: [] });   // 🎯 school demo student
  const data = all.filter(e => e.open_to !== 'paid' || me.full).map(e => _view(e, byEvent.get(String(e._id)), countBy.get(String(e._id)) || 0, now, e.is_trial ? null : nextOf(e), app, dayOf(e)));
  // a free student: the class's paid practice papers are shown locked ("🔒 subscribe")
  const locked = me.full || me.guest ? [] : [...new Map(all.filter(e => e.open_to === 'paid' && e.kind === 'daily' && e.ends_at > now)
    .map(e => [e.schedule_id, { title: e.title, batch: e.batch, subject: e.subject, starts_at: e.starts_at, question_count: e.questions?.length || 0, duration_minutes: e.duration_minutes }])).values()];
  // website: after the family's first महा-Test, the next ones are in the app only
  const appOnly = !app && data.length ? await _priorEntry(await _familyCodes(me), now) : false;
  // the name is always shown now (no "माझं नाव दाखवा" question)
  res.json({ success: true, data, consent: true, app_only: appOnly, app_only_msg: appOnly ? APP_ONLY_MSG : '', locked });
});

// GET /api/weekly/public?batch=… — for the public महा-Test page (no login): the next महा-Test of
// the class (when, length, sections, how many registered) and last week's top 10 (hidden names stay hidden)
const _pubCache = new Map();
async function mahaTestOf(batch) {
  const hit = _pubCache.get(batch);
  if (hit && Date.now() - hit.at < 60e3) return hit.data;
  const now = _now();
  const next = await WeeklyEvent.findOne({ batch, kind: { $ne: 'daily' }, is_trial: { $ne: true }, status: { $ne: 'skipped' }, ends_at: { $gt: now } }).sort({ starts_at: 1 }).select('-questions').lean();
  const last = await WeeklyEvent.findOne({ batch, kind: { $ne: 'daily' }, is_trial: { $ne: true }, ends_at: { $lte: now } }).sort({ starts_at: -1 }).select('-questions').lean();
  const regs = next ? await WeeklyEntry.countDocuments({ event_id: String(next._id) }) : 0;
  const qn = async ev => ev.question_count || (await WeeklyEvent.findById(ev._id, 'questions').lean())?.questions?.length || 0;
  const data = {
    batch,
    next: next ? { event_id: String(next._id), title: next.title, starts_at: next.starts_at, ends_at: next.ends_at, duration_minutes: next.duration_minutes,
      question_count: await qn(next), sections: (next.sections || []).map(s => ({ subject: s.subject, count: s.count, marks: s.marks })), negative: next.negative || 0,
      open_to: next.open_to || 'all', registered_count: regs, state: now < next.starts_at ? 'upcoming' : 'live' } : null,
    last: last && now >= W.revealOf(last) ? { starts_at: last.starts_at, participants: last.participants || 0,
      toppers: (last.toppers || []).slice(0, 10).map(t => ({ rank: t.rank, name: HIDDEN_NAME, score: t.score, total: t.total })) } : null,
  };
  _pubCache.set(batch, { at: Date.now(), data });
  return data;
}
exports.mahaTestOf = mahaTestOf;
exports.clearPublicCache = () => _pubCache.clear();
exports.publicInfo = asyncHandler(async (req, res) => {
  const batch = String(req.query.batch || '').trim().slice(0, 120);
  if (!batch) throw new AppError('batch is required', 400);
  res.json({ success: true, data: await mahaTestOf(batch) });
});

// POST /api/weekly/:id/register
// "माझं नाव दाखवा" is asked once, at the first महा-Test registration. Has this
// student / visitor already answered it? (toppers_consent_at = when they answered;
// hide_in_toppers = they chose not to show the name.)
async function _consented(req, me) {
  if (me.guest) return !!(await GuestLead.exists({ gid: me.code.replace(/^GUEST-/, ''), toppers_consent_at: { $ne: null } }));
  return !!req.userDoc.toppers_consent_at;
}

async function _saveConsent(req, me, show) {
  const set = { toppers_consent_at: _now(), hide_in_toppers: !show };
  if (me.guest) await GuestLead.updateOne({ gid: me.code.replace(/^GUEST-/, '') }, { $set: set });
  else {
    await User.updateOne({ role: 'student', student_code: me.code }, { $set: set });
    invalidateUserCache('student', req.userDoc.user_id);
  }
  await WeeklyEvent.updateMany({ 'toppers.code': me.code }, { $set: { 'toppers.$[t].hidden': !show } }, { arrayFilters: [{ 't.code': me.code }] });
}

exports.register = asyncHandler(async (req, res) => {
  const me = _me(req);
  const ev = await _eventFor(req, me);
  // practice papers need no registration: the class's paid students just start in the first minutes
  if (ev.kind === 'daily') return res.status(400).json({ success: false, code: 'NO_REGISTER', message: 'रोजच्या Paper Practice ला register करायची गरज नाही — वेळ झाली की सुरू करा' });
  if (_now() >= ev.ends_at) throw new AppError('हा महा-Test संपला', 400);
  if (await _webBlocked(req, me)) return res.status(403).json({ success: false, code: 'APP_ONLY', message: APP_ONLY_MSG });
  // the name now always shows in the app's rank board (owner 2026-11-16); the answer is still noted once
  if (!(await _consented(req, me))) await _saveConsent(req, me, true);
  await WeeklyEntry.updateOne(
    { event_id: String(ev._id), student_code: me.code },
    { $setOnInsert: { name: me.name, is_guest: me.guest, registered_at: _now() } },
    { upsert: true }
  );
  _pubCache.delete(ev.batch);   // the public page counts this registration at once
  if (me.guest) require('../utils/waBot').notify(me.code.replace(/^GUEST-/, ''), 'sync', {}, { sync: { mtReg: true, mtNext: ev.starts_at } });
  res.json({ success: true });
});

// GET /api/weekly/:id/paper — encrypted questions (no answers), any time before the end.
exports.paper = asyncHandler(async (req, res) => {
  const me = _me(req);
  const ev = await _eventFor(req, me, { withKey: true });
  if (_now() >= ev.ends_at) throw new AppError('हा महा-Test संपला', 400);
  res.set('Cache-Control', 'private, max-age=3600');
  res.json({ success: true, data: { event_id: String(ev._id), duration_minutes: ev.duration_minutes, starts_at: ev.starts_at, ends_at: ev.ends_at, paper_order: ev.paper_order || '', ...W.encryptPaper(ev) } });
});

// GET /api/weekly/:id/key — only once the test has started (~50 bytes).
exports.key = asyncHandler(async (req, res) => {
  const me = _me(req);
  const ev = await _eventFor(req, me, { withKey: true });
  const now = _now();
  if (now < ev.starts_at) return res.status(425).json({ success: false, code: 'NOT_YET', starts_at: ev.starts_at });
  if (now >= ev.ends_at) throw new AppError('हा महा-Test संपला', 400);
  if (await _webBlocked(req, me)) return res.status(403).json({ success: false, code: 'APP_ONLY', message: APP_ONLY_MSG });
  // practice: a paper can be started only in its first minutes (the whole class writes it together);
  // one who already started may open it again (app closed / phone restarted)
  const entry = await WeeklyEntry.findOne({ event_id: String(ev._id), student_code: me.code }, 'started_at submitted_at').lean();
  if (ev.join_until && now > ev.join_until && !entry?.started_at) {
    return res.status(400).json({ success: false, code: 'JOIN_CLOSED', message: `हा paper ${_hm(ev.join_until)} पर्यंतच सुरू करता येतो — पुढच्या paper ला वेळेवर या` });
  }
  if (!entry?.started_at) {
    await WeeklyEntry.updateOne({ event_id: String(ev._id), student_code: me.code },
      { $set: { started_at: now }, $setOnInsert: { name: me.name, is_guest: me.guest, registered_at: now } }, { upsert: true });
  }
  res.json({ success: true, key: ev.key_b64 });
});

// a day of papers: my marks so far today, paper by paper, and the day total (e.g. MAT 68 + SAT 72 = 140/180)
async function _daySoFar(ev, code) {
  const evs = await WeeklyEvent.find({ schedule_id: ev.schedule_id, day_key: ev.day_key, is_trial: { $ne: true }, status: { $ne: 'skipped' } }, 'subject sections starts_at').sort({ starts_at: 1 }).lean();
  const mine = await WeeklyEntry.find({ event_id: { $in: evs.map(e => String(e._id)) }, student_code: code, submitted_at: { $ne: null } }, 'event_id score total').lean();
  const r2 = n => Math.round(n * 100) / 100;
  const papers = evs.map(e => { const m = mine.find(x => x.event_id === String(e._id)); const t = r2((e.sections || []).reduce((n, x) => n + x.count * x.marks, 0)); return { subject: e.subject, score: m ? m.score : null, total: m ? m.total : t }; });
  return { papers, score: r2(papers.reduce((n, x) => n + (x.score || 0), 0)), total: r2(papers.reduce((n, x) => n + (x.total || 0), 0)), final: !!ev.day_final };
}

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
    return res.json({ success: true, already: true, data: { score: existing.score, total: existing.total, correct: existing.correct, wrong: existing.wrong, skipped: existing.skipped, by_subject: existing.by_subject || [] } });
  }
  const g = W.grade(ev, Array.isArray(req.body?.answers) ? req.body.answers.slice(0, 200) : []);
  const maxSec = ev.duration_minutes * 60;
  const timeTaken = Math.min(maxSec, Math.max(0, Math.round(Number(req.body?.time_taken) || maxSec)));
  await WeeklyEntry.updateOne(
    { event_id: String(ev._id), student_code: me.code },
    { $set: { submitted_at: now, answers: g.answers, score: g.score, total: g.total, correct: g.correct, wrong: g.wrong, skipped: g.skipped, by_subject: g.by_subject,
      time_taken: timeTaken, leave_count: Math.max(0, Number(req.body?.leave_count) || 0), name: me.name, is_guest: me.guest },
      $setOnInsert: { registered_at: now } },
    { upsert: true }
  );
  res.json({ success: true, data: { score: g.score, total: g.total, correct: g.correct, wrong: g.wrong, skipped: g.skipped, by_subject: g.by_subject, ...(ev.day_key ? { day: await _daySoFar(ev, me.code) } : {}) } });
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
  const app = _isApp(req);
  const given = new Map((mine?.answers || []).map(a => [a.q_id, a.given]));
  // the family's first महा-Test: the whole result free — answers + उकल too (owner 2026-11-16); later ones: paid only
  const first = !me.full && !!mine?.submitted_at && !(await _priorEntry(await _familyCodes(me), mine.submitted_at, String(ev._id)));
  const open = me.full || first;
  res.json({
    success: true,
    data: {
      event_id: String(ev._id), subject: ev.subject, participants: ev.participants,
      paper_order: ev.paper_order || '', negative: ev.negative || 0,
      me: mine?.submitted_at ? { score: mine.score, total: mine.total, correct: mine.correct, wrong: mine.wrong, skipped: mine.skipped, rank: mine.rank, time_taken: mine.time_taken, by_subject: mine.by_subject || [] } : null,
      top: top.map(t => ({ name: !app && t.student_code !== me.code ? HIDDEN_NAME : (String(t.name || '').trim().slice(0, 40) || 'Student'), score: t.score, total: t.total, rank: t.rank, me: t.student_code === me.code })),
      hide_in_toppers: false,
      // महा-Test is free for everyone; the answer key + उकल: the family's first महा-Test, then paid students only
      review_locked: !open,
      first_free: first,
      review: ev.questions.map(q => ({ q_id: q.q_id, type: q.type, question: q.question, options: q.options, answer: open ? q.answer : '', explanation: open ? q.explanation : '', image: q.image, subject: q.subject || '', marks: q.marks || 1, given: given.get(q.q_id) || '' })),
      // a day of papers (practice / महा-Test on one day): my day total + the day's rank board (9.0.1+)
      kind: ev.kind || 'weekly', title: ev.title, day_final: !!ev.day_final, ...(ev.day_key ? await _dayBoard(ev, me, app) : {}),
    },
  });
});

async function _dayBoard(ev, me, app) {
  const mine = await PracticeDay.findOne({ schedule_id: ev.schedule_id, day_key: ev.day_key, student_code: me.code }).lean();
  const final = !!mine?.final || !!(await PracticeDay.exists({ schedule_id: ev.schedule_id, day_key: ev.day_key, final: true }));
  const rows = final ? await PracticeDay.find({ schedule_id: ev.schedule_id, day_key: ev.day_key }).sort({ rank: 1, score: -1 }).limit(50).lean() : [];
  return {
    day_key: ev.day_key,
    day: mine ? { score: mine.score, total: mine.total, rank: final ? mine.rank : null, participants: mine.participants, final,
      papers: (mine.papers || []).map(x => ({ subject: x.subject, score: x.score, total: x.total, by_subject: x.by_subject || [] })) } : null,
    day_top: rows.map(d => ({ name: !app && d.student_code !== me.code ? HIDDEN_NAME : (String(d.name || '').trim().slice(0, 40) || 'Student'), score: d.score, total: d.total, rank: d.rank, me: d.student_code === me.code,
      papers: (d.papers || []).map(x => ({ subject: x.subject, score: x.score })) })),
  };
}

// consecutive practice days given, counted back from the latest (today's not given yet doesn't break it)
const _streak = (dayKeys, given) => { let n = 0; for (const k of dayKeys) { if (given.has(k)) n++; else if (n || k !== dayKeys[0]) break; } return n; };

// GET /api/weekly/practice/me — my practice days (newest first), streak
exports.practiceMe = asyncHandler(async (req, res) => {
  const me = _me(req);
  const since = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  const days = await PracticeDay.find({ student_code: me.code, kind: 'daily', day_key: { $gte: since } }).sort({ day_key: -1 }).limit(45).lean();
  const evs = await WeeklyEvent.find({ batch: { $in: me.batches }, kind: 'daily', is_trial: { $ne: true }, status: 'results', day_final: true, day_key: { $gte: since } }, 'day_key').sort({ day_key: -1 }).lean();
  const given = new Set(days.map(d => d.day_key));
  const keys = [...new Set(evs.map(e => e.day_key))];
  res.json({ success: true, data: {
    streak: _streak(keys, given), held: keys.length, given: keys.filter(k => given.has(k)).length,
    days: days.map(d => ({ day_key: d.day_key, title: d.title, batch: d.batch, score: d.score, total: d.total, rank: d.final ? d.rank : null, participants: d.participants, final: d.final,
      papers: (d.papers || []).map(x => ({ subject: x.subject, score: x.score, total: x.total, by_subject: x.by_subject || [] })) })),
  } });
});

// Teacher (his students) / parent (the children): every practice day of the last N days, each child's
// paper marks (MAT / SAT and its subjects), day total, rank — and who did not give it.
async function _practiceReport(codes, daysBack) {
  const { hasFullAccess } = require('../utils/contentAccess');
  const since = new Date(Date.now() - daysBack * 864e5).toISOString().slice(0, 10);
  const students = await User.find({ role: 'student', student_code: { $in: codes }, demo_of_teacher: { $in: [null, ''] } }, 'student_code name assigned_batches role free_tier expiry_date').lean();   // not the school demo student
  const batches = [...new Set(students.flatMap(s => s.assigned_batches || []))];
  const evs = batches.length ? await WeeklyEvent.find({ batch: { $in: batches }, kind: 'daily', is_trial: { $ne: true }, status: { $ne: 'skipped' }, day_key: { $gte: since }, starts_at: { $lte: _now() } },
    'schedule_id batch title subject day_key day_final status starts_at sections').sort({ starts_at: 1 }).lean() : [];
  const rows = await PracticeDay.find({ student_code: { $in: codes }, kind: 'daily', day_key: { $gte: since } }).lean();
  const groups = new Map();
  for (const e of evs) {
    const k = e.schedule_id + '|' + e.day_key;
    if (!groups.has(k)) groups.set(k, { schedule_id: e.schedule_id, batch: e.batch, title: e.title, day_key: e.day_key, papers: [], final: false });
    const g = groups.get(k);
    g.papers.push({ subject: e.subject, total: Math.round((e.sections || []).reduce((n, x) => n + x.count * x.marks, 0) * 100) / 100, done: e.status === 'results' });
    if (e.day_final && e.status === 'results') g.final = true;
  }
  const daysOut = [...groups.values()].sort((a, b) => b.day_key.localeCompare(a.day_key)).map(g => {
    const inBatch = students.filter(s => (s.assigned_batches || []).includes(g.batch));
    const total = g.papers.reduce((n, p) => n + p.total, 0);
    const list = inBatch.map(s => {
      const d = rows.find(r => r.schedule_id === g.schedule_id && r.day_key === g.day_key && r.student_code === s.student_code);
      if (!d) return { code: s.student_code, name: s.name || '', given: false, paid: hasFullAccess(s), score: null, total, rank: null, papers: g.papers.map(p => ({ subject: p.subject, score: null, total: p.total })) };
      return { code: s.student_code, name: s.name || d.name || '', given: true, paid: true, score: d.score, total: d.total, rank: d.final ? d.rank : null, participants: d.participants,
        papers: g.papers.map(p => { const x = (d.papers || []).find(y => y.subject === p.subject); return x ? { subject: p.subject, score: x.score, total: x.total, by_subject: x.by_subject || [] } : { subject: p.subject, score: null, total: p.total }; }) };
    }).sort((a, b) => (b.given - a.given) || ((a.rank ?? 1e9) - (b.rank ?? 1e9)) || String(a.name).localeCompare(String(b.name)));
    return { ...g, total, students: list };
  });
  const streakOf = new Map();
  for (const s of students) {
    const keys = [...new Set(daysOut.filter(g => (s.assigned_batches || []).includes(g.batch) && g.final).map(g => g.day_key))];
    const given = new Set(rows.filter(r => r.student_code === s.student_code).map(r => r.day_key));
    streakOf.set(s.student_code, _streak(keys, given));
  }
  daysOut.forEach(g => g.students.forEach(x => { x.streak = streakOf.get(x.code) || 0; }));
  return { days: daysOut };
}
exports.practiceTeacher = asyncHandler(async (req, res) => {
  const t = req.userDoc || await User.findOne({ user_id: req.user.id }).lean();
  const codes = (t?.assigned_students || []).filter(Boolean);
  const days = Math.min(31, Math.max(1, Number(req.query.days) || 7));
  res.json({ success: true, data: codes.length ? await _practiceReport(codes, days) : { days: [] } });
});
exports.practiceParent = asyncHandler(async (req, res) => {
  const p = req.userDoc || await User.findOne({ user_id: req.user.id }).lean();
  const codes = p?.role === 'student' ? [p.student_code] : (p?.children || []).map(c => String(c).trim().toUpperCase());
  const days = Math.min(31, Math.max(1, Number(req.query.days) || 14));
  res.json({ success: true, data: codes.filter(Boolean).length ? await _practiceReport(codes.filter(Boolean), days) : { days: [] } });
});

// GET /api/weekly/history — Me › Analytics "🏆 माझे महा-Test": every महा-Test this child gave (newest first, up to 30)
exports.history = asyncHandler(async (req, res) => {
  const me = _me(req);
  const codes = await _familyCodes(me);
  const entries = await WeeklyEntry.find({ student_code: { $in: codes }, submitted_at: { $ne: null } })
    .sort({ submitted_at: -1 }).limit(40).select('event_id score total correct wrong skipped rank time_taken by_subject submitted_at').lean();
  const evs = await WeeklyEvent.find({ _id: { $in: entries.map(e => e.event_id) }, is_trial: { $ne: true } })
    .select('batch subject title starts_at ends_at reveal_at participants status').lean();
  const byId = new Map(evs.map(e => [String(e._id), e]));
  const now = _now();
  const data = entries.filter(e => byId.has(e.event_id)).slice(0, 30).map(e => {
    const ev = byId.get(e.event_id), results = now >= W.revealOf(ev);
    return { event_id: e.event_id, batch: ev.batch, subject: ev.subject, title: ev.title || 'महा-Test', starts_at: ev.starts_at, reveal_at: W.revealOf(ev),
      results, participants: results ? ev.participants || 0 : 0, rank: results ? e.rank ?? null : null,
      score: e.score, total: e.total, correct: e.correct, wrong: e.wrong, skipped: e.skipped, time_taken: e.time_taken, by_subject: e.by_subject || [],
      can_open: me.batches.includes(ev.batch) };
  });
  res.json({ success: true, data });
});

// POST /api/weekly/toppers/privacy { hide } — show / hide my name on toppers and rank boards.
exports.toppersPrivacy = asyncHandler(async (req, res) => {
  const me = _me(req);
  const hide = req.body?.hide === true;
  if (me.guest) await GuestLead.updateOne({ gid: me.code.replace(/^GUEST-/, '') }, { $set: { hide_in_toppers: hide } });
  else await User.updateOne({ role: 'student', student_code: me.code }, { $set: { hide_in_toppers: hide } });
  invalidateUserCache('student', req.userDoc.user_id);
  // banners already saved
  await WeeklyEvent.updateMany({ 'toppers.code': me.code }, { $set: { 'toppers.$[t].hidden': hide } }, { arrayFilters: [{ 't.code': me.code }] });
  res.json({ success: true, hide });
});

// ── Admin ────────────────────────────────────────────────────────────────────

const _ALLOWED = ['batch', 'title', 'enabled', 'day_of_week', 'start_time', 'result_time', 'window_minutes', 'duration_minutes', 'question_count', 'question_types', 'question_source', 'subjects', 'open_to', 'mode', 'papers',
  'kind', 'slots', 'join_minutes', 'start_date', 'end_date', 'skip_dates', 'papers_same_day', 'gap_minutes', 'banner_top'];
const _DATE = /^\d{4}-\d{2}-\d{2}$/;
const _HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function _pick(body) {
  const out = {};
  for (const k of _ALLOWED) if (body?.[k] !== undefined) out[k] = body[k];
  if (out.question_types) out.question_types = [].concat(out.question_types).filter(t => ['mcq', 'tf', 'fib'].includes(t));
  if (out.subjects) out.subjects = [].concat(out.subjects).map(s => String(s).trim()).filter(Boolean);
  if (out.mode !== undefined && !['subject', 'papers'].includes(out.mode)) out.mode = 'subject';
  if (out.papers !== undefined) {
    out.papers = [].concat(out.papers || []).slice(0, 10).map(p => ({
      name: String(p?.name || '').trim().slice(0, 60),
      order: p?.order === 'mix' ? 'mix' : 'sections',
      negative: Math.min(10, Math.max(0, Number(p?.negative) || 0)),
      parts: [].concat(p?.parts || []).slice(0, 20).map(x => ({
        subject: String(x?.subject || '').trim(),
        chapters: [].concat(x?.chapters || []).map(c => String(c).trim()).filter(Boolean).slice(0, 200),
        count: Math.min(200, Math.max(1, Math.round(Number(x?.count) || 1))),
        marks: Math.min(20, Math.max(0.25, Number(x?.marks) || 1)),
      })).filter(x => x.subject),
    }));
    if (out.papers.some(p => !p.name)) throw new AppError('प्रत्येक पेपरला नाव द्या', 400);
    if (out.papers.some(p => !p.parts.length)) throw new AppError('प्रत्येक पेपरमध्ये किमान एक विषय निवडा', 400);
  }
  if (out.mode === 'papers' && out.papers !== undefined && !out.papers.length) throw new AppError('किमान एक पेपर बनवा', 400);
  if (out.kind !== undefined) out.kind = out.kind === 'daily' ? 'daily' : 'weekly';
  if (out.slots !== undefined) {
    out.slots = [].concat(out.slots || []).slice(0, 60).map(x => ({ paper: String(x?.paper || '').trim().slice(0, 60), dow: Math.round(Number(x?.dow)), time: String(x?.time || '').trim() }))
      .filter(x => x.paper && x.dow >= 0 && x.dow <= 6 && _HHMM.test(x.time));
  }
  if (out.kind === 'daily') {
    if (out.mode !== undefined && out.mode !== 'papers') throw new AppError('रोजच्या Practice साठी "Mixed पेपर" निवडा', 400);
    if (out.slots !== undefined && !out.slots.length) throw new AppError('किमान एका पेपरची वेळ आणि दिवस द्या', 400);
    if (out.papers && out.slots && out.slots.some(x => !out.papers.some(p => p.name === x.paper))) throw new AppError('वेळापत्रकातील पेपरचं नाव पेपरमध्ये नाही', 400);
  }
  if (out.join_minutes !== undefined) out.join_minutes = Math.min(180, Math.max(0, Math.round(Number(out.join_minutes) || 0)));
  if (out.gap_minutes !== undefined) out.gap_minutes = Math.min(240, Math.max(0, Math.round(Number(out.gap_minutes) || 0)));
  if (out.banner_top !== undefined) out.banner_top = Math.min(10, Math.max(3, Math.round(Number(out.banner_top) || 10)));
  if (out.papers_same_day !== undefined) out.papers_same_day = out.papers_same_day === true;
  for (const k of ['start_date', 'end_date']) if (out[k] !== undefined) { out[k] = String(out[k] || '').trim(); if (out[k] && !_DATE.test(out[k])) throw new AppError('तारीख चुकीची', 400); }
  if (out.skip_dates !== undefined) out.skip_dates = [...new Set([].concat(out.skip_dates || []).map(d => String(d).trim()).filter(d => _DATE.test(d)))].sort().slice(-200);
  return out;
}

exports.adminSchedules = asyncHandler(async (_req, res) => {
  const schedules = await WeeklySchedule.find({}).sort({ batch: 1 }).lean();
  const next = await WeeklyEvent.find({ schedule_id: { $in: schedules.map(s => String(s._id)) }, ends_at: { $gt: new Date() }, is_trial: { $ne: true } }).select('schedule_id subject starts_at ends_at reveal_at status questions.q_id shortages').lean();
  const nextBy = new Map(next.map(e => [e.schedule_id, { subject: e.subject, starts_at: e.starts_at, ends_at: e.ends_at, reveal_at: W.revealOf(e), status: e.status, questions: e.questions?.length || 0, shortages: e.shortages || [] }]));
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
  await W.remakeUpcoming(s._id);   // (in the same queue as the scheduler tick — never two tests at once)
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
    return res.json({ success: true, existing: true, data: { event_id: String(running._id), subject: running.subject, starts_at: running.starts_at, ends_at: running.ends_at, questions: running.questions.length, shortages: running.shortages || [] } });
  }
  const raw = Number(req.body?.start_in_minutes);
  const startIn = Math.min(Math.max(Number.isFinite(raw) ? raw : 2, 0), 120);
  // a long practice paper (90 min) gets its whole time in the trial too
  const windowMin = Math.min(Math.max(Number(req.body?.window_minutes) || 30, 10, s.kind === 'daily' ? s.duration_minutes : 0), 240);
  const pi = req.body?.paper !== undefined && Number.isInteger(Number(req.body.paper)) && s.papers?.[Number(req.body.paper)] ? Number(req.body.paper) : null;
  const trialSched = { ...s, window_minutes: windowMin, ...(pi !== null ? { papers: [s.papers[pi]], next_paper_index: 0 } : {}) };
  const ev = await W.generateEvent(trialSched, new Date(Date.now() + startIn * 60000), { trial: true });
  if (!ev) throw new AppError('या class ला विषय नाहीत', 400);
  if (ev.status === 'skipped') throw new AppError(ev.skip_reason, 400);
  res.status(201).json({ success: true, data: { event_id: String(ev._id), subject: ev.subject, starts_at: ev.starts_at, ends_at: ev.ends_at, questions: ev.questions.length, shortages: ev.shortages || [] } });
});

// GET /api/weekly/admin/schedules/:id/preview?paper=0 — the next days' papers (when, which) and one
// paper made now as a sample (least-used questions, nothing saved), with answers, for the admin.
exports.adminPreview = asyncHandler(async (req, res) => {
  const s = await WeeklySchedule.findById(req.params.id).lean().catch(() => null);
  if (!s) throw new AppError('Not found', 404);
  if (s.mode !== 'papers' || !s.papers?.length) throw new AppError('Preview फक्त Mixed पेपरसाठी', 400);
  const pi = Math.min(s.papers.length - 1, Math.max(0, Number(req.query.paper) || 0));
  const usage = await W.usageMap(s.batch);
  const built = await W.buildPaper(s, s.papers[pi], { usage });
  const fresh = built.questions.filter(q => !usage.get(W._qkey(q))).length;
  const now = _now();
  const upcoming = s.kind === 'daily' ? W.dailySlots(s, now, 8).filter(x => x.start > now).slice(0, 14).map(x => ({ paper: x.paper, starts_at: x.start, day_key: x.day_key, final: x.final })) : [];
  res.json({ success: true, data: {
    paper: s.papers[pi].name, sections: built.sections, shortages: built.shortages, fresh, total: built.questions.length, upcoming,
    questions: built.questions.map(q => ({ subject: q.subject, chapter: q.chapter, question: q.question, options: q.options, answer: q.answer, image: q.image })),
  } });
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
  for (const s of b.subjects || []) {
    const pool = await W.questionPool(batch, s.name, types, source);
    const ch = new Map();
    pool.forEach(q => { const k = String(q.chapter || '').trim() || '(chapter नाही)'; ch.set(k, (ch.get(k) || 0) + 1); });
    data.push({ subject: s.name, questions: pool.length, chapters: [...ch].map(([chapter, questions]) => ({ chapter, questions })) });
  }
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
