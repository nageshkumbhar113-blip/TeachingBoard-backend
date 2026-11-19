// 🔔 Notification timetable (owner 2026-11-19): every automatic notification at a fixed IST time the admin can
// change or switch off, plus the admin's own notifications (a message, who gets it, when, once / daily /
// weekly). The free Render server sleeps when idle, so the WhatsApp bot (Cloudflare) is told these times and
// wakes it a few minutes before each one ("gajar") — see utils/adsAwake.js.
//
// Fixed jobs (default times):
//   morning      06:30  thought of the day + today's Study Plan + "haven't studied for days"
//   teacher_chat 17:00  Personal Digital Teacher: today's tasks are waiting
//   plan_evening 17:00  Study Plan evening reminder
//   guest        17:00  free-test families with the app
//   nudge        20:45  paid students without a Study Plan: "study today" (after the SAT result)
//   digest       08:45  Monday: the teachers' weekly Study Plan report
// Paper Pattern Practice / महा-Test reminders and results keep their own times (15 min before a paper, and
// when its result is out); only their wake-up times are added here.
const { mongoose } = require('../config/db');

const JOBS = {
  morning:      { time: '06:30', name: '🌅 सकाळ: आजचा विचार, आजचा Study Plan, "अभ्यास केला नाही" आठवण' },
  teacher_chat: { time: '17:00', name: '🧑‍🏫 Digital Teacher: आजची कामं बाकी आहेत' },
  plan_evening: { time: '17:00', name: '📋 Study Plan संध्याकाळची आठवण' },
  guest:        { time: '17:00', name: '🎁 Free test दिलेल्या पालकांना आठवण' },
  nudge:        { time: '20:45', name: '📚 "आज अभ्यास करा" (Study Plan नसलेले paid विद्यार्थी)' },
  digest:       { time: '08:45', dow: 1, name: '👩‍🏫 शिक्षकांना आठवड्याचा अहवाल (सोमवार)' },
};
const AUDIENCES = ['all', 'batch', 'paid', 'parents', 'teachers'];
const WINDOW_MIN = 180;          // a job missed by more than 3 h is not sent late (no morning message at night)
const IST_MS = 5.5 * 3600e3;

const schema = new mongoose.Schema({
  key:  { type: String, default: 'main', unique: true },
  jobs: { type: mongoose.Schema.Types.Mixed, default: {} },            // { morning: { on, time }, … }
  custom: { type: [{
    title: { type: String, trim: true, maxlength: 80 },
    body:  { type: String, trim: true, maxlength: 300 },
    audience: { type: String, default: 'all' },
    batch: { type: String, default: '', trim: true },
    repeat: { type: String, default: 'once' },                          // once | daily | weekly
    date:  { type: String, default: '' },                               // once: YYYY-MM-DD (IST)
    dow:   { type: Number, default: 0 },                                // weekly: 0 = Sunday
    time:  { type: String, default: '19:00' },
    on:    { type: Boolean, default: true },
    last_key: { type: String, default: '' },                            // the IST day it last went out
    last_sent: { type: Number, default: 0 },                            // how many phones it reached
  }], default: [] },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false });
const NotifyConfig = mongoose.models.NotifyConfig || mongoose.model('NotifyConfig', schema);

let _cfg = null, _at = 0;
async function config(force = false) {
  if (!force && _cfg && Date.now() - _at < 60e3) return _cfg;
  const doc = await NotifyConfig.findOne({ key: 'main' }).lean().catch(() => null);
  _cfg = { jobs: doc?.jobs || {}, custom: doc?.custom || [] }; _at = Date.now();
  return _cfg;
}
const okTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
function ist(now = new Date()) {
  const d = new Date(now.getTime() + IST_MS);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}
// the IST instant of day `key` (YYYY-MM-DD) at hh:mm
const at = (key, hhmm) => { const [y, mo, da] = key.split('-').map(Number), [h, m] = hhmm.split(':').map(Number); return Date.UTC(y, mo - 1, da, h, m) - IST_MS; };

function jobSetting(cfg, key) {
  const s = cfg.jobs?.[key] || {};
  return { on: s.on !== false, time: okTime(s.time) ? s.time : JOBS[key].time, dow: JOBS[key].dow };
}
// is the fixed job `key` due now? (on, its time has come today, not more than 3 h ago, right weekday)
async function due(key, now = new Date()) {
  const s = jobSetting(await config(), key), t = ist(now);
  if (!s.on) return false;
  if (s.dow !== undefined && t.dow !== s.dow) return false;
  const m = toMin(s.time);
  return t.min >= m && t.min < m + WINDOW_MIN;
}

// ── the admin's own notifications ──
async function _tokens(n) {
  const User = require('../models/User');
  const { hasFullAccess } = require('./contentAccess');
  const { parentTokensFor } = require('./parentTokens');
  const live = u => !['inactive', 'blocked', 'deleted'].includes(String(u.status || ''));
  if (n.audience === 'teachers') {
    return (await User.find({ role: 'teacher', status: 'active', device_token: { $nin: [null, ''] } }, 'device_token').lean()).map(u => u.device_token);
  }
  const q = { role: 'student' };
  if (n.audience === 'batch' && n.batch) q.assigned_batches = n.batch;
  const kids = (await User.find(q, 'student_code role free_tier expiry_date status device_token').lean()).filter(live);
  if (n.audience === 'parents') return parentTokensFor(kids.map(k => k.student_code));
  const list = n.audience === 'paid' ? kids.filter(u => hasFullAccess(u)) : kids;
  return list.map(u => u.device_token).filter(Boolean);
}
// the day (YYYY-MM-DD) of the occurrence that is due now, or '' — today's or yesterday's (a 23:50 one is
// still sent at 00:05), at most 3 h late, once per occurrence
function customDue(n, now = new Date()) {
  if (!n.on || !okTime(n.time)) return '';
  const t = ist(now);
  for (const back of [0, 1]) {
    const day = new Date(at(t.date, '12:00') - back * 864e5 + IST_MS), key = day.toISOString().slice(0, 10), dow = day.getUTCDay();
    if (n.repeat === 'once' && n.date !== key) continue;
    if (n.repeat === 'weekly' && Number(n.dow) !== dow) continue;
    const T = at(key, n.time);
    if (now.getTime() >= T && now.getTime() < T + WINDOW_MIN * 60000 && n.last_key !== key) return key;
  }
  return '';
}
async function runCustom(now = new Date()) {
  const cfg = await config(true);
  const { sendToMany } = require('./fcm');
  for (const n of cfg.custom) {
    const key = customDue(n, now);
    if (!key) continue;
    // claim it first (two ticks at once must not send it twice)
    const claim = await NotifyConfig.updateOne({ key: 'main', custom: { $elemMatch: { _id: n._id, last_key: { $ne: key } } } }, { $set: { 'custom.$.last_key': key } });
    if (!claim.modifiedCount) continue;
    const tokens = [...new Set(await _tokens(n))];
    if (tokens.length) await sendToMany(tokens, n.title, n.body, { type: 'admin_notice' }).catch(err => console.warn('custom notification failed:', err.message));
    await NotifyConfig.updateOne({ key: 'main', 'custom._id': n._id }, { $set: { 'custom.$.last_sent': tokens.length, ...(n.repeat === 'once' ? { 'custom.$.on': false } : {}) } });
    console.log(`[notify] "${n.title}" → ${tokens.length} phones`);
  }
  _cfg = null;
}

// ── when the server must be awake (the next ~26 h): the bot's "gajar" ──
async function wakeTimes(now = new Date()) {
  const cfg = await config(), from = now.getTime(), to = from + 26 * 3600e3, out = [];
  const t0 = ist(now);
  const days = [0, 1, 2].map(k => new Date(at(t0.date, '12:00') + k * 864e5)).map(d => ({ key: new Date(d.getTime() + IST_MS).toISOString().slice(0, 10), dow: new Date(d.getTime() + IST_MS).getUTCDay() }));
  for (const key of Object.keys(JOBS)) {
    const s = jobSetting(cfg, key);
    if (!s.on) continue;
    for (const d of days) if (s.dow === undefined || s.dow === d.dow) out.push(at(d.key, s.time));
  }
  for (const n of cfg.custom) {
    if (!n.on || !okTime(n.time)) continue;
    for (const d of days) {
      if (n.repeat === 'once' && n.date !== d.key) continue;
      if (n.repeat === 'weekly' && Number(n.dow) !== d.dow) continue;
      out.push(at(d.key, n.time));
    }
  }
  // practice papers (from the timetable, also not-yet-made ones) and महा-Tests: the reminder and the result
  try {
    const W = require('./weeklyTests');
    const WeeklySchedule = require('../models/WeeklySchedule');
    const WeeklyEvent = require('../models/WeeklyEvent');
    for (const s of await WeeklySchedule.find({ enabled: true, kind: 'daily' }).lean()) {
      for (const sl of W.dailySlots(s, now, 2)) {
        const st = sl.start.getTime(), end = st + (Number(s.duration_minutes) || 0) * 60000;
        out.push(st - 15 * 60000, end + 5 * 60000);
      }
    }
    for (const e of await WeeklyEvent.find({ status: 'scheduled', is_trial: { $ne: true }, kind: { $ne: 'daily' }, starts_at: { $lte: new Date(to) }, ends_at: { $gte: now } }, 'starts_at ends_at reveal_at').lean()) {
      out.push(e.starts_at.getTime() - 15 * 60000, e.ends_at.getTime(), (e.reveal_at || e.ends_at).getTime() + 5 * 60000);
    }
  } catch (err) { console.warn('[notify] wake times (tests):', err.message); }
  return [...new Set(out.filter(x => x >= from - 15 * 60000 && x <= to).map(x => Math.round(x / 60000) * 60000))].sort((a, b) => a - b).slice(0, 80);
}

// ── Admin ──
function view(cfg) {
  return {
    jobs: Object.entries(JOBS).map(([key, j]) => ({ key, name: j.name, ...jobSetting(cfg, key), default_time: j.time })),
    custom: cfg.custom.map(n => ({ id: String(n._id), title: n.title, body: n.body, audience: n.audience, batch: n.batch, repeat: n.repeat, date: n.date, dow: n.dow, time: n.time, on: n.on, last_key: n.last_key, last_sent: n.last_sent })),
  };
}
async function save(body) {
  const jobs = {};
  for (const key of Object.keys(JOBS)) {
    const j = body?.jobs?.[key] || {};
    if (j.time !== undefined && !okTime(j.time)) throw Object.assign(new Error(`${JOBS[key].name}: वेळ HH:MM हवी`), { status: 400 });
    jobs[key] = { on: j.on !== false, time: okTime(j.time) ? j.time : JOBS[key].time };
  }
  const old = new Map(((await config(true)).custom || []).map(n => [String(n._id), n]));
  const custom = (Array.isArray(body?.custom) ? body.custom : []).slice(0, 50).map((n, i) => {
    const where = `Notification ${i + 1}`;
    const title = String(n.title || '').trim().slice(0, 80), text = String(n.body || '').trim().slice(0, 300);
    if (!title) throw Object.assign(new Error(`${where}: शीर्षक लिहा`), { status: 400 });
    if (!AUDIENCES.includes(n.audience)) throw Object.assign(new Error(`${where}: कोणाला ते निवडा`), { status: 400 });
    if (n.audience === 'batch' && !String(n.batch || '').trim()) throw Object.assign(new Error(`${where}: batch निवडा`), { status: 400 });
    if (!['once', 'daily', 'weekly'].includes(n.repeat)) throw Object.assign(new Error(`${where}: एकदा / रोज / दर आठवड्याला`), { status: 400 });
    if (!okTime(n.time)) throw Object.assign(new Error(`${where}: वेळ HH:MM हवी`), { status: 400 });
    if (n.repeat === 'once' && !/^\d{4}-\d{2}-\d{2}$/.test(String(n.date || ''))) throw Object.assign(new Error(`${where}: तारीख निवडा`), { status: 400 });
    const prev = n.id && old.get(String(n.id));
    // a changed one-time notification may go out again
    const changed = prev && (prev.date !== n.date || prev.time !== n.time || prev.repeat !== n.repeat);
    return {
      ...(prev ? { _id: prev._id } : {}),
      title, body: text, audience: n.audience, batch: n.audience === 'batch' ? String(n.batch).trim() : '',
      repeat: n.repeat, date: n.repeat === 'once' ? n.date : '', dow: Math.max(0, Math.min(6, Number(n.dow) || 0)), time: n.time,
      on: n.on !== false, last_key: prev && !changed ? prev.last_key : '', last_sent: prev ? prev.last_sent : 0,
    };
  });
  await NotifyConfig.updateOne({ key: 'main' }, { $set: { jobs, custom } }, { upsert: true });
  return view(await config(true));
}

module.exports = { JOBS, config, due, runCustom, wakeTimes, view, save, ist, NotifyConfig };
