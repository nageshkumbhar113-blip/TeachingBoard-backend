const crypto = require('crypto');
const Batch = require('../models/Batch');
const Question = require('../models/Question');
const Quiz = require('../models/Quiz');
const WeeklySchedule = require('../models/WeeklySchedule');
const WeeklyEvent = require('../models/WeeklyEvent');
const WeeklyEntry = require('../models/WeeklyEntry');
const PracticeDay = require('../models/PracticeDay');
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
// "Same question" (also across tests): figure questions share one direction text, so pictures count.
function _qkey(q) {
  return _norm(q.question) + '|' + (q.image || '') + '|' + Object.values(q.option_images || {}).filter(Boolean).join(',')
    + '|' + Object.keys(q.options || {}).sort().map(k => _norm(q.options[k])).join('¦');
}

// How often each question of the class already came in its महा-Tests / practice papers (the
// last 400 tests): a daily paper takes the least used ones first, so no question comes back
// before every question of the bank has come once.
async function usageMap(batch) {
  const evs = await WeeklyEvent.find({ batch, is_trial: { $ne: true }, status: { $ne: 'skipped' } }, 'questions.question questions.image questions.option_images questions.options')
    .sort({ starts_at: -1 }).limit(400).lean();
  const m = new Map();
  for (const e of evs) for (const q of e.questions || []) { const k = _qkey(q); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

// `want` questions of a pool: least used first; among the equally used, the NMMS-like mix
// easy 40 % / medium 40 % / hard 20 % as far as the bank allows, else at random.
function pickFresh(pool, want, usage) {
  const uses = q => usage?.get(_qkey(q)) || 0;
  const sorted = _shuffle(pool).sort((a, b) => uses(a) - uses(b));
  if (sorted.length <= want) return sorted;
  const edge = uses(sorted[want - 1]);
  const forced = sorted.filter(q => uses(q) < edge);          // fresher than the edge: all of them
  const tier = sorted.filter(q => uses(q) === edge);
  const quota = { easy: Math.round(want * 0.4), hard: Math.round(want * 0.2) };
  quota.medium = want - quota.easy - quota.hard;
  forced.forEach(q => { quota[q.difficulty || 'medium']--; });
  const picked = [...forced], rest = [];
  for (const q of tier) {
    if (picked.length >= want) break;
    const d = q.difficulty || 'medium';
    if (quota[d] > 0) { quota[d]--; picked.push(q); } else rest.push(q);
  }
  for (const q of rest) { if (picked.length >= want) break; picked.push(q); }
  return _shuffle(picked);
}

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
    // Figure questions share one direction text, so pictures are part of "same question".
    const key = _qkey(q);
    if (seen.has(key)) return;
    seen.add(key);
    pool.push({
      q_id: String(q.q_id || crypto.randomUUID()), type, question: q.question, options: q.options || {},
      answer: String(q.answer), explanation: q.explanation || '', image: q.image || null,
      option_images: q.option_images || {}, chapter: chapter || q.chapter || '',
      difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
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

// A mixed paper (schedule mode 'papers'): each part's questions, the chosen
// chapters only, `count` of them at random; parts kept in order or mixed.
async function buildPaper(schedule, paper, { usage = null } = {}) {
  const picked = [], sections = [], shortages = [];
  const used = new Set();   // one question never twice in a paper (two parts may share a subject)
  for (const part of paper.parts || []) {
    const chapters = new Set((part.chapters || []).map(_norm));
    let pool = await questionPool(schedule.batch, part.subject, schedule.question_types, schedule.question_source);
    if (chapters.size) pool = pool.filter(q => chapters.has(_norm(q.chapter)));
    pool = pool.filter(q => !used.has(_qkey(q)));
    const want = Math.max(1, Number(part.count) || 1), marks = Number(part.marks) || 1;
    const take = (usage ? pickFresh(pool, want, usage) : _shuffle(pool).slice(0, want)).map(q => ({ ...q, subject: part.subject, marks }));
    take.forEach(q => used.add(_qkey(q)));
    if (take.length < want) shortages.push({ subject: part.subject, want, got: take.length });
    if (take.length) sections.push({ subject: part.subject, count: take.length, marks });
    picked.push(...take);
  }
  return { questions: paper.order === 'mix' ? _shuffle(picked) : picked, sections, shortages };
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
  if (schedule.mode === 'papers' && schedule.papers?.length) return _generatePaperEvent(schedule, startsAt, { trial });
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

// Mixed papers take turns (MAT, SAT, MAT…); a paper with no questions at all is skipped for the next one.
// `paperIndex`: this very paper (practice slots, महा-Test with every paper on one day) — no turns.
// `extra`: fields of the event set by the caller (day, join time, end, result time…).
async function _generatePaperEvent(schedule, startsAt, { trial = false, paperIndex = null, extra = {} } = {}) {
  const papers = schedule.papers;
  const usage = await usageMap(schedule.batch);
  let idx = schedule.next_paper_index || 0, paper = null, built = null;
  if (paperIndex !== null) {
    paper = papers[paperIndex];
    built = await buildPaper(schedule, paper, { usage });
  }
  // the turn follows the last real test (MAT → SAT → MAT…), so a lost or doubled step can't repeat a paper
  if (paperIndex === null && !trial) {
    const last = await WeeklyEvent.findOne({ schedule_id: String(schedule._id), is_trial: { $ne: true }, starts_at: { $lt: startsAt } }, 'subject').sort({ starts_at: -1 }).lean();
    const at = last ? papers.findIndex(p => p.name === last.subject) : -1;
    if (at >= 0) idx = at + 1;
  }
  for (let tries = 0; paperIndex === null && tries < papers.length; tries++) {
    const p = papers[idx % papers.length];
    idx++;
    const b = await buildPaper(schedule, p, { usage });
    if (b.questions.length) { paper = p; built = b; break; }
    if (!paper) { paper = p; built = b; }
  }
  if (paperIndex === null && !trial) await WeeklySchedule.updateOne({ _id: schedule._id }, { $set: { next_paper_index: idx % papers.length } });
  const endsAt = extra.ends_at || new Date(startsAt.getTime() + schedule.window_minutes * 60000);
  const join = Number(schedule.join_minutes) || 0;
  const base = {
    schedule_id: String(schedule._id), batch: schedule.batch, title: schedule.title || 'महा-Test', subject: paper.name,
    starts_at: startsAt, ends_at: endsAt, reveal_at: trial ? endsAt : revealAt(schedule, startsAt, endsAt),
    duration_minutes: schedule.duration_minutes, open_to: schedule.open_to, is_trial: trial,
    paper_order: paper.order || 'sections', negative: Number(paper.negative) || 0, sections: built.sections, shortages: built.shortages,
    kind: schedule.kind || 'weekly', join_until: join ? new Date(startsAt.getTime() + join * 60000) : null,
    ...extra,
  };
  if (trial) { base.reveal_at = endsAt; base.join_until = null; }
  if (!built.questions.length) return WeeklyEvent.create({ ...base, status: 'skipped', skip_reason: 'पेपरच्या निवडलेल्या विषय / chapters मध्ये प्रश्न नाहीत' });
  return WeeklyEvent.create({ ...base, questions: built.questions, key_b64: crypto.randomBytes(32).toString('base64') });
}

// One at a time: the scheduler tick and an admin's Save both make the next test; run together
// they each saw "nothing pending" and made one (two महा-Tests at the same time). Everything that
// makes or remakes a real test goes through this queue.
let _queue = Promise.resolve();
function withScheduleLock(fn) {
  const run = _queue.then(fn);
  _queue = run.catch(() => {});
  return run;
}
// an admin changed a schedule: its not-yet-started test is made again with the new settings
function remakeUpcoming(scheduleId) {
  return withScheduleLock(async () => {
    await WeeklyEvent.deleteMany({ schedule_id: String(scheduleId), is_trial: { $ne: true }, starts_at: { $gt: new Date() } });
    await _ensureUpcoming();
  });
}

// Every enabled schedule has its next event ready (made up to 7 days ahead,
// so phones can download the paper early). Called by the scheduler tick.
function ensureUpcoming(now = new Date()) { return withScheduleLock(() => _ensureUpcoming(now)); }
async function _ensureUpcoming(now = new Date()) {
  const schedules = await WeeklySchedule.find({ enabled: true }).lean();
  for (const s of schedules) {
    const papers = s.mode === 'papers' && s.papers?.length;
    if (s.kind === 'daily') {
      if (papers) await _ensureDaily(s, now).catch(err => console.warn('practice paper generate failed:', err.message));
      continue;
    }
    if (papers && s.papers_same_day) {
      await _ensureSameDay(s, now).catch(err => console.warn('weekly test generate failed:', err.message));
      continue;
    }
    const pending = await WeeklyEvent.exists({ schedule_id: String(s._id), is_trial: false, ends_at: { $gt: now } });
    if (pending) continue;
    const start = nextStart(s, now);
    if (start) await generateEvent(s, start).catch(err => console.warn('weekly test generate failed:', err.message));
  }
}

// ── Paper Pattern Practice (kind 'daily') ────────────────────────────────────
const RESULT_DELAY_MS = 5 * 60 * 1000;   // practice result 5 min after the paper closes (late auto-submits get in)
const dayKeyOf = d => new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10);
function _atIst(dayKey, hhmm) {
  const [y, mo, da] = dayKey.split('-').map(Number), [h, m] = String(hhmm).split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, da, h, m) - IST_MS);
}
function dayOpen(s, key) {
  if (s.start_date && key < s.start_date) return false;
  if (s.end_date && key > s.end_date) return false;
  return !(s.skip_dates || []).includes(key);
}
// Every practice paper of the next `days` days (from the IST day of `from`), in time order.
function dailySlots(s, from = new Date(), days = 15) {
  const names = new Set((s.papers || []).map(p => p.name));
  const base = _atIst(dayKeyOf(from), '12:00').getTime();
  const out = [];
  for (let add = 0; add <= days; add++) {
    const key = dayKeyOf(new Date(base + add * 864e5));
    if (!dayOpen(s, key)) continue;
    const dow = new Date(_atIst(key, '12:00').getTime() + IST_MS).getUTCDay();
    for (const sl of s.slots || []) {
      if (Number(sl.dow) === dow && names.has(sl.paper)) out.push({ start: _atIst(key, sl.time), paper: sl.paper, day_key: key });
    }
  }
  out.sort((a, b) => a.start - b.start);
  out.forEach(x => { x.final = !out.some(y => y.day_key === x.day_key && y.start > x.start); });
  return out;
}
// the event fields of one practice slot: fixed end for everyone, result a little later, the day,
// and — for the day's last paper — the banner stays till the next day's result
function _slotExtra(s, slot, slots) {
  const endsAt = new Date(slot.start.getTime() + s.duration_minutes * 60000);
  const reveal = new Date(endsAt.getTime() + RESULT_DELAY_MS);
  let bannerUntil = null;
  if (slot.final) {
    const next = slots.find(y => y.final && y.start > slot.start);
    bannerUntil = next ? new Date(next.start.getTime() + s.duration_minutes * 60000 + RESULT_DELAY_MS) : new Date(reveal.getTime() + 2 * 864e5);
  }
  return { ends_at: endsAt, reveal_at: reveal, kind: 'daily', day_key: slot.day_key, day_final: slot.final, banner_until: bannerUntil };
}
const DAILY_AHEAD_MS = 36 * 3600 * 1000;
async function _ensureDaily(s, now) {
  // a paper that started a few minutes ago (server was busy / schedule just saved) still counts
  const late = Math.max(Number(s.join_minutes) || 0, 1) * 60000;
  const slots = dailySlots(s, new Date(now.getTime() - late));
  let haveNext = false;
  for (const x of slots) {
    if (x.start.getTime() <= now.getTime() - late) continue;
    // always the next paper; besides it, every paper of the next 36 hours
    if (haveNext && x.start.getTime() > now.getTime() + DAILY_AHEAD_MS) break;
    haveNext = true;
    if (await WeeklyEvent.exists({ schedule_id: String(s._id), is_trial: false, starts_at: x.start })) continue;   // already made
    const pi = s.papers.findIndex(p => p.name === x.paper);
    await _generatePaperEvent(s, x.start, { paperIndex: pi, extra: _slotExtra(s, x, slots) });
  }
}

// ── महा-Test with every paper on one day (paper 1, gap, paper 2 …) ───────────
function _sameDayStarts(s, base) {
  const span = Math.max(Number(s.window_minutes) || 0, Number(s.duration_minutes) || 0);
  const gap = Number(s.gap_minutes ?? 60) || 0;
  return s.papers.map((_, i) => new Date(base.getTime() + i * (span + gap) * 60000));
}
async function _ensureSameDay(s, now) {
  const n = s.papers.length;
  const span = Math.max(Number(s.window_minutes) || 0, Number(s.duration_minutes) || 0);
  const whole = (n * span + (n - 1) * (Number(s.gap_minutes ?? 60) || 0)) * 60000;
  const make = async base => {
    const starts = _sameDayStarts(s, base), key = dayKeyOf(base);
    for (let i = 0; i < n; i++) {
      const st = starts[i], endsAt = new Date(st.getTime() + s.window_minutes * 60000);
      if (endsAt <= now) continue;
      if (await WeeklyEvent.exists({ schedule_id: String(s._id), is_trial: false, starts_at: st })) continue;
      // one result time for the whole day: the schedule's result time, never before the last paper ends
      const lastEnd = new Date(starts[n - 1].getTime() + s.window_minutes * 60000);
      await _generatePaperEvent(s, st, { paperIndex: i, extra: { ends_at: endsAt, reveal_at: revealAt(s, st, lastEnd), day_key: key, day_final: i === n - 1 } });
    }
  };
  const current = nextStart(s, new Date(now.getTime() - whole));   // today's group if still running
  if (current && current <= now) await make(current);
  if (!(await WeeklyEvent.exists({ schedule_id: String(s._id), is_trial: false, ends_at: { $gt: now } }))) {
    const next = nextStart(s, now);
    if (next) await make(next);
  }
}

// AES-256-GCM, WebCrypto-compatible: data = ciphertext || tag.
function encryptPaper(event) {
  const key = Buffer.from(event.key_b64, 'base64');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = JSON.stringify(event.questions.map(q => ({
    q_id: q.q_id, type: q.type, question: q.question, options: q.options, image: q.image, option_images: q.option_images, chapter: q.chapter,
    ...(event.paper_order ? { subject: q.subject, marks: q.marks } : {}),
  })));
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), data: data.toString('base64') };
}

function isCorrect(q, given) {
  const g = String(given ?? '').trim();
  if (!g) return false;
  if (q.type === 'fib') return _norm(g) === _norm(q.answer);
  const opts = q.options || {};
  if (g === q.answer) return true;
  // compare the option text only when there is text (picture options have empty text — never a match)
  const gt = _norm(opts[g] ?? g), at = _norm(opts[q.answer] ?? q.answer);
  return gt !== '' && gt === at;
}

// One subject: a mark a question, nothing off. Mixed paper: each question's marks, `negative`
// off for a wrong answer, and the marks per subject.
function grade(event, answers) {
  const byId = new Map((answers || []).map(a => [String(a.q_id), String(a.given ?? '')]));
  const paper = !!event.paper_order, neg = paper ? Number(event.negative) || 0 : 0;
  let correct = 0, wrong = 0, skipped = 0, score = 0, total = 0;
  const kept = [], subj = new Map();
  for (const q of event.questions) {
    const given = byId.get(q.q_id) || '';
    const m = paper ? Number(q.marks) || 1 : 1;
    const s = paper ? (subj.get(q.subject) || subj.set(q.subject, { subject: q.subject, score: 0, total: 0, correct: 0, wrong: 0 }).get(q.subject)) : null;
    kept.push({ q_id: q.q_id, given });
    total += m; if (s) s.total += m;
    if (!given) skipped++;
    else if (isCorrect(q, given)) { correct++; score += m; if (s) { s.correct++; s.score += m; } }
    else { wrong++; score -= neg; if (s) { s.wrong++; s.score -= neg; } }
  }
  const r2 = n => Math.round(n * 100) / 100;
  return { correct, wrong, skipped, score: r2(score), total: r2(total), answers: kept,
    by_subject: [...subj.values()].map(s => ({ ...s, score: r2(s.score), total: r2(s.total) })) };
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
  const sched = await WeeklySchedule.findById(event.schedule_id, 'banner_top').lean().catch(() => null);
  const topN = Math.min(10, Math.max(3, Number(sched?.banner_top) || 10));
  const toppers = await _toppersOf(ranked.map(({ e, rank }) => ({ rank, name: e.name, score: e.score, total: e.total, code: e.student_code })), topN);
  await WeeklyEvent.updateOne({ _id: event._id }, { $set: { participants: entries.length, toppers } });
  if (event.day_key) await finalizeDay(event, topN).catch(err => console.warn('practice day total failed:', err.message));
  // the WhatsApp bot: each free visitor's result to the parent
  const BOT = require('./waBot');
  if (BOT.on()) for (const { e, rank } of ranked) if (e.is_guest) BOT.notify(String(e.student_code).replace(/^GUEST-/, ''), 'mt_result', { score: e.score, total: e.total, rank, of: entries.length });
  return WeeklyEvent.findById(event._id);
}

// ranked rows → the saved toppers list (top `n`, names checked for "hide my name")
async function _toppersOf(rows, n) {
  const top = rows.filter(x => x.rank <= n).slice(0, n);
  const hidden = await hiddenCodes(top.map(x => x.code));
  return top.map(x => ({ rank: x.rank, name: String(x.name || '').trim().slice(0, 40) || 'Student', score: x.score, total: x.total, code: x.code, hidden: hidden.has(x.code) }));
}

const _paperMarks = ev => Math.round((ev.sections || []).reduce((n, s) => n + (Number(s.count) || 0) * (Number(s.marks) || 0), 0) * 100) / 100;

// One of a day's papers got its result: every child's day total (a paper not given counts 0),
// rank by the total (then the time taken), and — once the day's last paper is out — the day's
// toppers on that last paper for the Home banner.
async function finalizeDay(event, topN = 10) {
  const evs = await WeeklyEvent.find({ schedule_id: event.schedule_id, day_key: event.day_key, is_trial: { $ne: true }, status: { $ne: 'skipped' } })
    .select('subject status starts_at day_final sections batch title kind').sort({ starts_at: 1 }).lean();
  if (!evs.length) return;
  const ids = evs.map(e => String(e._id));
  const entries = await WeeklyEntry.find({ event_id: { $in: ids }, submitted_at: { $ne: null } })
    .select('event_id student_code name score total by_subject rank time_taken').lean();
  const dayTotal = Math.round(evs.reduce((n, e) => n + _paperMarks(e), 0) * 100) / 100;
  const final = evs.some(e => e.day_final) && evs.every(e => e.status === 'results');
  const by = new Map();
  for (const x of entries) {
    const d = by.get(x.student_code) || by.set(x.student_code, { code: x.student_code, name: x.name, papers: [], score: 0, time: 0 }).get(x.student_code);
    d.papers.push({ event_id: x.event_id, subject: evs.find(e => String(e._id) === x.event_id)?.subject || '', score: x.score, total: x.total, rank: x.rank ?? null, by_subject: x.by_subject || [] });
    d.score += Number(x.score) || 0; d.time += Number(x.time_taken) || 0;
    if (x.name) d.name = x.name;
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  const rows = [...by.values()].map(d => ({ ...d, score: Math.round(d.score * 100) / 100, papers: d.papers.sort((a, b) => order.get(a.event_id) - order.get(b.event_id)) }))
    .sort((a, b) => b.score - a.score || a.time - b.time);
  let rank = 0, prev = null;
  rows.forEach((d, i) => { const k = `${d.score}|${d.time}`; if (k !== prev) { rank = i + 1; prev = k; } d.rank = rank; });
  const base = { schedule_id: event.schedule_id, batch: evs[0].batch, title: evs[0].title || '', kind: evs[0].kind || 'daily', day_key: event.day_key };
  if (rows.length) {
    await PracticeDay.bulkWrite(rows.map(d => ({
      updateOne: {
        filter: { schedule_id: event.schedule_id, day_key: event.day_key, student_code: d.code },
        update: { $set: { ...base, name: d.name || '', papers: d.papers, score: d.score, total: dayTotal, rank: d.rank, participants: rows.length, final } },
        upsert: true,
      },
    })));
  }
  if (!final) return;
  const last = evs.filter(e => e.day_final).pop();
  const dayToppers = await _toppersOf(rows.map(d => ({ rank: d.rank, name: d.name, score: d.score, total: dayTotal, code: d.code })), topN);
  await WeeklyEvent.updateOne({ _id: last._id }, { $set: { day_toppers: dayToppers, day_participants: rows.length } });
}

async function finalizeDue(now = new Date()) {
  const due = await WeeklyEvent.find({ status: 'scheduled', ends_at: { $lte: now } }).limit(50);
  for (const e of due) if (revealOf(e) <= now) await finalizeIfDue(e, now).catch(err => console.warn('weekly finalize failed:', err.message));
}

// ── Practice notifications (kind 'daily') ────────────────────────────────────
// 15 minutes before each paper: the class's paid students; after the result: each child who gave
// it (and the parent's phone) — the paper's marks, and on the day's last paper the day total + rank.
const _clock = d => new Date(new Date(d).getTime() + IST_MS).toISOString().slice(11, 16);
async function _paidStudents(batch, codes = null) {
  const { hasFullAccess } = require('./contentAccess');
  const q = { role: 'student', assigned_batches: batch };
  if (codes) q.student_code = { $in: codes };
  const rows = await User.find(q, 'student_code name role free_tier expiry_date status device_token parent_device_token demo_of_teacher').lean();
  return rows.filter(u => hasFullAccess(u) && !u.demo_of_teacher && !['inactive', 'blocked', 'deleted'].includes(String(u.status || '')));
}
async function _parentTokens(codes) {
  const parents = await User.find({ role: 'parent', children: { $in: codes }, device_token: { $nin: [null, ''] } }, 'children device_token').lean();
  const m = new Map();
  for (const p of parents) for (const c of p.children || []) { if (!m.has(c)) m.set(c, []); m.get(c).push(p.device_token); }
  return m;
}
async function notifyDue(now = new Date()) {
  const { sendToMany } = require('./fcm');
  const soon = await WeeklyEvent.find({ kind: 'daily', is_trial: { $ne: true }, status: 'scheduled', notified_pre: { $ne: true },
    starts_at: { $gt: now, $lte: new Date(now.getTime() + 15 * 60000) } }).select('batch subject title starts_at duration_minutes sections').lean();
  for (const ev of soon) {
    const c = await WeeklyEvent.updateOne({ _id: ev._id, notified_pre: { $ne: true } }, { $set: { notified_pre: true } });
    if (!c.modifiedCount) continue;
    const tokens = [...new Set((await _paidStudents(ev.batch)).map(u => u.device_token).filter(Boolean))];
    const n = (ev.sections || []).reduce((k, x) => k + (x.count || 0), 0);
    await sendToMany(tokens, `⏰ 15 मिनिटांत ${ev.subject} paper`, `${ev.title} · ${n} प्रश्न · ${ev.duration_minutes} मिनिटं · ${_clock(ev.starts_at)} ला सुरू — वेळेवर या`, { type: 'practice_paper', event_id: String(ev._id) })
      .catch(err => console.warn('practice reminder push failed:', err.message));
  }
  const done = await WeeklyEvent.find({ kind: 'daily', is_trial: { $ne: true }, status: 'results', notified_result: { $ne: true },
    results_at: { $gt: new Date(now.getTime() - 6 * 3600e3) } }).select('batch subject title day_key day_final schedule_id').lean();
  for (const ev of done) {
    const c = await WeeklyEvent.updateOne({ _id: ev._id, notified_result: { $ne: true } }, { $set: { notified_result: true } });
    if (!c.modifiedCount) continue;
    const entries = await WeeklyEntry.find({ event_id: String(ev._id), submitted_at: { $ne: null } }, 'student_code score total rank').lean();
    if (!entries.length) continue;
    const codes = entries.map(e => e.student_code);
    const days = ev.day_final ? new Map((await PracticeDay.find({ schedule_id: ev.schedule_id, day_key: ev.day_key, student_code: { $in: codes } }).lean()).map(d => [d.student_code, d])) : new Map();
    const users = new Map((await User.find({ role: 'student', student_code: { $in: codes } }, 'student_code name device_token parent_device_token').lean()).map(u => [u.student_code, u]));
    const parents = await _parentTokens(codes);
    for (const e of entries) {
      const u = users.get(e.student_code), d = days.get(e.student_code);
      const tokens = [...new Set([u?.device_token, u?.parent_device_token, ...(parents.get(e.student_code) || [])].filter(Boolean))];
      if (!tokens.length) continue;
      const who = u?.name ? `${u.name}: ` : '';
      const title = d
        ? `🏆 आजचा निकाल: ${d.score}/${d.total}${d.rank ? ' · rank #' + d.rank : ''}`
        : `📝 ${ev.subject}: ${e.score}/${e.total}${e.rank ? ' · rank #' + e.rank : ''}`;
      const body = d
        ? `${who}${d.papers.map(p => `${p.subject} ${p.score}/${p.total}`).join(' · ')} · ${d.participants} विद्यार्थी`
        : `${who}${ev.title} — उत्तरं आणि उकल app मध्ये`;
      await sendToMany(tokens, title, body, { type: 'practice_result', event_id: String(ev._id) }).catch(() => {});
    }
  }
}

module.exports = { _qkey, hiddenCodes, revealAt, revealOf, nextStart, questionPool, buildPaper, pickFresh, usageMap, generateEvent, ensureUpcoming, remakeUpcoming, withScheduleLock, encryptPaper, grade, isCorrect, finalizeIfDue, finalizeDue, finalizeDay, dailySlots, dayKeyOf, dayOpen, notifyDue };
