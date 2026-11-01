const crypto = require('crypto');
const Batch = require('../models/Batch');
const Question = require('../models/Question');
const Quiz = require('../models/Quiz');
const WeeklySchedule = require('../models/WeeklySchedule');
const WeeklyEvent = require('../models/WeeklyEvent');
const WeeklyEntry = require('../models/WeeklyEntry');
const User = require('../models/User');
const GuestLead = require('../models/GuestLead');

// Codes (student codes / GUEST-<gid>) whose name must not be shown publicly:
// no parent consent yet, or the name was hidden later.
async function hiddenCodes(codes) {
  const students = codes.filter(c => !c.startsWith('GUEST-'));
  const gids = codes.filter(c => c.startsWith('GUEST-')).map(c => c.slice(6));
  const ok = { toppers_consent_at: { $ne: null }, hide_in_toppers: { $ne: true } };
  const [u, g] = await Promise.all([
    students.length ? User.find({ role: 'student', student_code: { $in: students }, ...ok }, 'student_code').lean() : [],
    gids.length ? GuestLead.find({ gid: { $in: gids }, ...ok }, 'gid').lean() : [],
  ]);
  const visible = new Set([...u.map(x => x.student_code), ...g.map(x => `GUEST-${x.gid}`)]);
  return new Set(codes.filter(c => !visible.has(c)));
}

// महा-Test automation (owner's design 2026-11-01): set up once per class,
// then every week a new test of the next subject is made automatically —
// N random questions of the chosen types from the whole subject.
//
// Low server load by design: the encrypted paper is downloaded ahead of time,
// the test runs on the phone, and the server only answers three tiny calls:
// the key at start time, the submit, and the result.

const IST_MS = 5.5 * 3600 * 1000;
const GRADABLE = new Set(['mcq', 'tf', 'fib']);

// Next start (UTC Date) for day_of_week + "HH:MM" in IST, strictly after `from`.
function nextStart(schedule, from = new Date()) {
  const [h, m] = String(schedule.start_time || '18:00').split(':').map(Number);
  const ist = new Date(from.getTime() + IST_MS);
  for (let add = 0; add <= 7; add++) {
    const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add, h, m) - IST_MS);
    const dow = new Date(d.getTime() + IST_MS).getUTCDay();
    if (dow === Number(schedule.day_of_week) && d.getTime() > from.getTime()) return d;
  }
  return null;
}

function _shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function _norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function _typeOf(q) {
  if (q.type) return q.type;
  const keys = Object.keys(q.options || {});
  return keys.length >= 2 ? 'mcq' : 'fib';
}

// Questions of a subject from the question bank and/or published tests.
async function questionPool(batch, subject, types, source) {
  const want = new Set((types && types.length ? types : ['mcq']).filter(t => GRADABLE.has(t)));
  const pool = [];
  const seen = new Set();
  const add = (q, chapter) => {
    const type = _typeOf(q);
    if (!want.has(type) || !q.question || !q.answer) return;
    if (type !== 'fib' && Object.keys(q.options || {}).length < 2) return;
    const key = _norm(q.question);
    if (seen.has(key)) return;
    seen.add(key);
    pool.push({
      q_id: String(q.q_id || crypto.randomUUID()), type, question: q.question, options: q.options || {},
      answer: String(q.answer), explanation: q.explanation || '', image: q.image || null,
      option_images: q.option_images || {}, chapter: chapter || q.chapter || '',
    });
  };
  if (source === 'bank' || source === 'both') {
    const bank = await Question.find({ batch, subject }).lean();
    bank.forEach(q => add(q, q.chapter));
  }
  if (source === 'tests' || source === 'both') {
    const quizzes = await Quiz.find({ batch, subject, status: 'published' }, 'chapter questions').lean();
    quizzes.forEach(z => (z.questions || []).forEach(q => add(q, z.chapter)));
  }
  return pool;
}

async function _subjectsOf(schedule) {
  if (schedule.subjects?.length) return schedule.subjects;
  const b = await Batch.findOne({ name: schedule.batch }, 'subjects.name').lean();
  return (b?.subjects || []).map(s => s.name).filter(Boolean);
}

// When the rank list opens: the schedule's result_time that day (IST), never
// before the window closes.
function revealAt(schedule, startsAt, endsAt) {
  const rt = String(schedule.result_time || '');
  if (!/^\d{2}:\d{2}$/.test(rt)) return endsAt;
  const [h, m] = rt.split(':').map(Number);
  const ist = new Date(startsAt.getTime() + IST_MS);
  const t = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), h, m) - IST_MS);
  return t > endsAt ? t : endsAt;
}

const revealOf = ev => new Date(ev.reveal_at || ev.ends_at);

// Make the event for one start time (round-robin subject; skips a subject
// with no usable questions and tries the next one).
async function generateEvent(schedule, startsAt, { trial = false } = {}) {
  const subjects = await _subjectsOf(schedule);
  if (!subjects.length) return null;
  let idx = schedule.next_subject_index || 0;
  let chosen = null, pool = [];
  for (let tries = 0; tries < subjects.length; tries++) {
    const subject = subjects[idx % subjects.length];
    idx++;
    pool = await questionPool(schedule.batch, subject, schedule.question_types, schedule.question_source);
    if (pool.length) { chosen = subject; break; }
  }
  if (!trial) await WeeklySchedule.updateOne({ _id: schedule._id }, { $set: { next_subject_index: idx % subjects.length } });
  const endsAt = new Date(startsAt.getTime() + schedule.window_minutes * 60000);
  const base = {
    schedule_id: String(schedule._id), batch: schedule.batch, title: schedule.title || 'महा-Test',
    starts_at: startsAt, ends_at: endsAt, reveal_at: trial ? endsAt : revealAt(schedule, startsAt, endsAt),
    duration_minutes: schedule.duration_minutes, open_to: schedule.open_to, is_trial: trial,
  };
  if (!chosen) {
    return WeeklyEvent.create({ ...base, subject: subjects[0], status: 'skipped', skip_reason: 'या class च्या कोणत्याही विषयात निवडलेल्या प्रकारचे प्रश्न नाहीत' });
  }
  const questions = _shuffle(pool).slice(0, schedule.question_count);
  return WeeklyEvent.create({ ...base, subject: chosen, questions, key_b64: crypto.randomBytes(32).toString('base64') });
}

// Every enabled schedule has its next event ready (made up to 7 days ahead,
// so phones can download the paper early). Called by the scheduler tick.
async function ensureUpcoming(now = new Date()) {
  const schedules = await WeeklySchedule.find({ enabled: true }).lean();
  for (const s of schedules) {
    const pending = await WeeklyEvent.exists({ schedule_id: String(s._id), is_trial: false, ends_at: { $gt: now } });
    if (pending) continue;
    const start = nextStart(s, now);
    if (start) await generateEvent(s, start).catch(err => console.warn('weekly test generate failed:', err.message));
  }
}

// AES-256-GCM, WebCrypto-compatible: data = ciphertext || tag.
function encryptPaper(event) {
  const key = Buffer.from(event.key_b64, 'base64');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = JSON.stringify(event.questions.map(q => ({
    q_id: q.q_id, type: q.type, question: q.question, options: q.options, image: q.image, option_images: q.option_images, chapter: q.chapter,
  })));
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), data: data.toString('base64') };
}

function isCorrect(q, given) {
  const g = String(given ?? '').trim();
  if (!g) return false;
  if (q.type === 'fib') return _norm(g) === _norm(q.answer);
  const opts = q.options || {};
  const answerText = opts[q.answer] ?? q.answer;
  return g === q.answer || _norm(opts[g] ?? g) === _norm(answerText);
}

function grade(event, answers) {
  const byId = new Map((answers || []).map(a => [String(a.q_id), String(a.given ?? '')]));
  let correct = 0, wrong = 0, skipped = 0;
  const kept = [];
  for (const q of event.questions) {
    const given = byId.get(q.q_id) || '';
    kept.push({ q_id: q.q_id, given });
    if (!given) skipped++;
    else if (isCorrect(q, given)) correct++;
    else wrong++;
  }
  return { correct, wrong, skipped, score: correct, total: event.questions.length, answers: kept };
}

// Once the window has closed: ranks for everyone, computed one time.
async function finalizeIfDue(event, now = new Date()) {
  if (!event || event.status !== 'scheduled' || revealOf(event) > now) return event;
  const claimed = await WeeklyEvent.findOneAndUpdate({ _id: event._id, status: 'scheduled' }, { $set: { status: 'results', results_at: now } }, { new: true });
  if (!claimed) return WeeklyEvent.findById(event._id);   // another tick did it
  const entries = await WeeklyEntry.find({ event_id: String(event._id), submitted_at: { $ne: null } }).sort({ score: -1, time_taken: 1 }).lean();
  let rank = 0, prev = null;
  const ops = entries.map((e, i) => {
    const key = `${e.score}|${e.time_taken}`;
    if (key !== prev) { rank = i + 1; prev = key; }
    return { updateOne: { filter: { _id: e._id }, update: { $set: { rank } } } };
  });
  if (ops.length) await WeeklyEntry.bulkWrite(ops);
  // top 10 for the Home banner, saved once
  let r = 0, p = null;
  const ranked = entries.map((e, i) => { const k = `${e.score}|${e.time_taken}`; if (k !== p) { r = i + 1; p = k; } return { e, rank: r }; });
  const top = ranked.filter(x => x.rank <= 10).slice(0, 10);
  const hidden = await hiddenCodes(top.map(x => x.e.student_code));
  const toppers = top.map(({ e, rank }) => ({
    rank, name: String(e.name || '').trim().slice(0, 40) || 'Student', score: e.score, total: e.total,
    code: e.student_code, hidden: hidden.has(e.student_code),
  }));
  await WeeklyEvent.updateOne({ _id: event._id }, { $set: { participants: entries.length, toppers } });
  return WeeklyEvent.findById(event._id);
}

async function finalizeDue(now = new Date()) {
  const due = await WeeklyEvent.find({ status: 'scheduled', ends_at: { $lte: now } }).limit(50);
  for (const e of due) if (revealOf(e) <= now) await finalizeIfDue(e, now).catch(err => console.warn('weekly finalize failed:', err.message));
}

module.exports = { hiddenCodes, revealAt, revealOf, nextStart, questionPool, generateEvent, ensureUpcoming, encryptPaper, grade, isCorrect, finalizeIfDue, finalizeDue };
