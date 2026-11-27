// 🎯 Teacher demo from an ad (owner 2026-11-20). A teacher books a demo (name, mobile, school/class) and at once gets:
//  • a teacher account — active straight away (no approval), random PIN; same limits as every teacher
//    (4 papers per batch, unlimited after 10 paid students); stays until the admin blocks / deletes it
//  • a "school demo विद्यार्थी" — code = 3 letters of the school + the teacher's last 4 mobile digits, random PIN,
//    the ad's course (now 8th NMMS) with every note and chapter test; NOT the paid daily papers / महा-Test /
//    ranks; never charged, never counted (paid, revenue, the 10-student rule). Open 48 h (DEMO_HOURS); after
//    that it opens again when the admin switches it on, or by itself while the teacher has 10 paid students
//    of that course — till their expiry (30 April), every year again.
// One account per mobile: a number already known (any teacher account) never gets a new code.
// The WhatsApp bot gets the teacher (CRM "Teacher (Ad)") and runs the 48-hour journey; the app tells it
// what the teacher did (login, paper, the demo student's test, students added) — see notify().
const { randomUUID, randomInt } = require('crypto');
const { mongoose } = require('../config/db');
const User = require('../models/User');
const Batch = require('../models/Batch');
const { isValidMobile } = require('./mobile');
const { isWeakPin } = require('./pin');
const { uniqueStudentCode } = require('./studentCode');
const { invalidateUserCache } = require('../middleware/auth');

const DEMO_HOURS = 72;   // owner 2026-11-26: the demo student 3 days (was 48 h)
const IST_MS = 5.5 * 3600e3;
// owner 2026-11-27: the teacher's student account is a REAL one (every paper, महा-Test, rank — no "demo" limits) and
// stays open till Sunday night (IST 23:59) — the Sunday 10 am live demo — then closes; it opens again by itself when
// the teacher has 10 paid students of that course (or the Admin's switch). Booked on a Sunday after the demo → the
// next Sunday. (The Admin's "hours" setting is no longer used.)
function untilSunday(now = new Date()) {
  const ist = new Date(now.getTime() + IST_MS);
  const dow = ist.getUTCDay();
  const add = dow === 0 ? (ist.getUTCHours() < 10 ? 0 : 7) : 7 - dow;
  const end = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add, 23, 59, 59));
  return new Date(end.getTime() - IST_MS);
}

const cfgSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  on: { type: Boolean, default: true },
  hours: { type: Number, default: DEMO_HOURS, min: 1, max: 240 },
  v72: { type: Boolean, default: false },   // the old default 48 h moved to 72 once
  course: { type: String, default: '' },   // the ad's course; '' = the first active NMMS course
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false });
const DemoConfig = mongoose.models.TeacherDemoConfig || mongoose.model('TeacherDemoConfig', cfgSchema);
async function config() {
  const c = await DemoConfig.findOne({ key: 'main' }).lean();
  if (c && !c.v72) {   // saved with the old 48 h default: 3 days now (owner 2026-11-26); an Admin's own value stays
    const hours = c.hours === 48 ? DEMO_HOURS : c.hours;
    await DemoConfig.updateOne({ _id: c._id }, { $set: { hours, v72: true } }).catch(() => {});
    return { ...c, hours, v72: true };
  }
  return c || { on: true, hours: DEMO_HOURS, course: '' };
}

function randomPin() { let p; do { p = String(randomInt(0, 10000)).padStart(4, '0'); } while (isWeakPin(p)); return p; }
// 30 April (end of day, IST) of the current school year
function yearEnd(now = new Date()) {
  const ist = new Date(now.getTime() + IST_MS), y = ist.getUTCMonth() >= 4 ? ist.getUTCFullYear() + 1 : ist.getUTCFullYear();
  return new Date(Date.UTC(y, 3, 30, 23, 59, 59) - IST_MS);
}

// the course for this booking: the ad's (if it is a real active course), else the admin's, else the first NMMS one
async function courseFor(asked) {
  const active = await Batch.find({ is_active: { $ne: false } }, 'name').lean();
  const names = active.map(b => b.name);
  const cfg = await config();
  for (const c of [asked, cfg.course]) if (c && names.includes(c)) return c;
  return names.find(n => /nmms/i.test(n)) || names[0] || '';
}

// tell the bot (fire-and-forget; nothing when the bot is not set up)
function notify(gid, data) {
  if (!gid) return;
  try { require('./waBot').notify(gid, 'tdemo', data); } catch { /* bot off */ }
}
// the bot's lead for a new demo teacher (server to server) → its id, or ''
async function botLead(body) {
  const url = process.env.WA_WORKER_URL, key = process.env.BOT_SHARED_SECRET;
  if (!url || !key) return '';
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/demo/lead', { method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', 'X-Bot-Key': key }, body: JSON.stringify({ kind: 'teacher_ad', ...body }) });
    const j = await r.json().catch(() => ({}));
    return /^[0-9A-F]{10}$/.test(j.gid || '') ? j.gid : '';
  } catch { return ''; }
}

// POST /api/teacher-demo/book { name, mobile, school, ad, course }
async function book(body, ip = '') {
  const cfg = await config();
  if (cfg.on === false) throw Object.assign(new Error('Demo सध्या बंद आहे — 8390484545 वर संपर्क करा'), { status: 503 });
  const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const mobile = String(body.mobile || '').replace(/\D/g, '').slice(-10);
  const school = String(body.school || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const ad = String(body.ad || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  if (!name) throw Object.assign(new Error('तुमचं नाव लिहा'), { status: 400 });
  if (!isValidMobile(mobile)) throw Object.assign(new Error('10 अंकी mobile नंबर लिहा'), { status: 400 });
  if (!school) throw Object.assign(new Error('शाळा / क्लासचं नाव लिहा'), { status: 400 });
  const now = new Date();

  // a number already known: never a new code
  const old = await User.findOne({ role: 'teacher', mobile });
  if (old && old.status !== 'pending') {
    const gid0 = /^[0-9A-F]{10}$/.test(String(body.gid || '')) ? String(body.gid) : '';
    if (gid0 && old.demo_gid !== gid0) await User.updateOne({ _id: old._id }, { $set: { demo_gid: gid0 } });   // the app's news now go to this chat
    else if (old.demo_gid && !gid0) notify(old.demo_gid, { again: true });
    const ds = await User.findOne({ role: 'student', demo_of_teacher: old.teacher_code }, 'student_code').lean();
    return { exists: true, teacher_code: old.teacher_code, name: old.name, student_code: ds?.student_code || '' };
  }

  const course = await courseFor(String(body.course || '').trim());
  if (!course) throw Object.assign(new Error('Course सापडला नाही — 8390484545 वर संपर्क करा'), { status: 503 });
  let teacher = old, tPin = '';
  if (teacher) {
    // signed up in the app and still waiting for approval: the same code, now active (PIN = the one they chose)
    teacher.status = 'active';
    teacher.approved_at = now;
    if (!teacher.institute_name) teacher.institute_name = school;
  } else {
    const prefix = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || require('./studentCode').namePrefix(name);
    let code = '';
    for (let i = 0; i < 20 && !code; i++) { const c = prefix + String(randomInt(100, 1000)); if (!(await User.exists({ teacher_code: c }))) code = c; }
    if (!code) throw Object.assign(new Error('पुन्हा प्रयत्न करा'), { status: 500 });
    tPin = randomPin();
    teacher = new User({
      user_id: `teacher-${randomUUID()}`, name, role: 'teacher', teacher_code: code, mobile, institute_name: school,
      partner_type: 'school', commission_enabled: false, commission_mode: 'percent', commission_value: 0,
      status: 'active', approved_at: now, request_source: 'demo', signup_ad: ad, assigned_students: [],
      pin_hash: User.hashPin(tPin),
    });
  }
  teacher.demo_booked_at = now;
  teacher.demo_course = course;

  // the school demo student (one per teacher)
  let student = await User.findOne({ role: 'student', demo_of_teacher: teacher.teacher_code });
  let sPin = '';
  const until = untilSunday(now);   // (was: now + cfg.hours)
  if (!student) {
    sPin = randomPin();
    const code = await uniqueStudentCode(school, mobile, async c => !!(await User.exists({ student_code: c })));
    student = new User({
      user_id: `student-${randomUUID()}`, name: `विद्यार्थी – ${school}`.slice(0, 80), role: 'student', student_code: code,
      mobile, status: 'active', assigned_batches: [course], expiry_date: until, free_tier: false, pin_hash: User.hashPin(sPin),
      approved_at: now, approved_by: 'demo', request_source: 'demo', school_name: school, referred_by_teacher: teacher.teacher_code,
      hide_in_toppers: true, demo_of_teacher: teacher.teacher_code, demo_until: until,
    });
    await student.save();
  }
  teacher.assigned_students = [...new Set([...(teacher.assigned_students || []), student.student_code])];
  await teacher.save();
  invalidateUserCache('teacher', teacher.user_id);

  // the bot (CRM "Teacher (Ad)" + the 48-hour journey)
  // the bot asked for it (WhatsApp, Teacher Guide): its own chat; else (the /book-demo page) a new bot lead
  const gid = /^[0-9A-F]{10}$/.test(String(body.gid || '')) ? String(body.gid)
    : await botLead({ name, mobile, school, ad, course, teacher_code: teacher.teacher_code, teacher_pin: tPin, student_code: student.student_code, student_pin: sPin, until: until.toISOString(), ip });
  if (gid && teacher.demo_gid !== gid) { teacher.demo_gid = gid; await User.updateOne({ _id: teacher._id }, { $set: { demo_gid: gid } }); }
  return {
    exists: false, gid, course, until,
    teacher: { name: teacher.name, code: teacher.teacher_code, pin: tPin || null },   // null = the PIN they chose at sign-up
    student: { name: student.name, code: student.student_code, pin: sPin || null },
  };
}

// ── the school demo student's access: demo window → admin switch → 10 paid students; every year again ──
async function _paidOf(teacher, course) {
  const StudentSubscription = require('../models/StudentSubscription');
  const codes = (teacher.assigned_students || []).filter(Boolean);
  if (!codes.length) return { n: 0, until: null };
  const subs = await StudentSubscription.find({ student_code: { $in: codes }, batch: course, payment_verified: true, is_trial: false, status: 'active', expiry_date: { $gt: new Date() } }, 'student_code expiry_date').lean();
  const n = new Set(subs.map(s => s.student_code)).size;
  return { n, until: subs.reduce((m, s) => (!m || s.expiry_date > m ? s.expiry_date : m), null) };
}
async function syncOne(student, now = new Date()) {
  const teacher = await User.findOne({ role: 'teacher', teacher_code: student.demo_of_teacher }).lean();
  let until = null, why = '';
  if (student.demo_until && new Date(student.demo_until) > now) { until = new Date(student.demo_until); why = 'demo'; }
  if (student.demo_admin_until && new Date(student.demo_admin_until) > now && (!until || student.demo_admin_until > until)) { until = new Date(student.demo_admin_until); why = 'admin'; }
  if (teacher && teacher.status !== 'blocked') {
    const course = (student.assigned_batches || [])[0];
    const p = course ? await _paidOf(teacher, course) : { n: 0 };
    if (p.n >= 10 && p.until && (!until || p.until > until)) { until = new Date(p.until); why = '10'; }
  } else until = null;
  // off = the access date in the past (login then says the access has ended), never 'blocked'
  const status = until ? 'active' : 'off';
  const exp = until || (student.expiry_date && new Date(student.expiry_date) > now ? now : student.expiry_date);
  const set = { demo_why: why, expiry_date: exp };
  if (student.status !== 'active' && student.status !== 'blocked') set.status = 'active';
  if (String(student.expiry_date) !== String(exp) || student.demo_why !== why || set.status) {
    await User.updateOne({ _id: student._id }, { $set: set });
    invalidateUserCache('student', student.user_id);
  }
  return { status, until, why };
}
let _lastSync = 0;
async function syncAll(force = false) {
  if (!force && Date.now() - _lastSync < 30 * 60e3) return;
  _lastSync = Date.now();
  for (const s of await User.find({ role: 'student', demo_of_teacher: { $nin: [null, ''] } }).lean()) await syncOne(s).catch(() => {});
}
// Admin: switch the school demo student on (till 30 April) / off
async function adminSwitch(teacherCode, on) {
  const s = await User.findOne({ role: 'student', demo_of_teacher: String(teacherCode || '').toUpperCase() });
  if (!s) throw Object.assign(new Error('या शिक्षकाचा school demo विद्यार्थी नाही'), { status: 404 });
  s.demo_admin_until = on ? yearEnd() : null;
  if (!on) s.demo_until = null;
  await s.save();
  return syncOne(s.toObject());
}

// a demo teacher's activity → the bot: by the teacher doc, or by a school demo student's doc
function teacherDid(teacher, data) { if (teacher?.demo_gid) notify(teacher.demo_gid, data); }
async function studentDid(student, data) {
  if (!student?.demo_of_teacher) return;
  const t = await User.findOne({ role: 'teacher', teacher_code: student.demo_of_teacher }, 'demo_gid').lean().catch(() => null);
  teacherDid(t, data);
}

module.exports = { teacherDid, studentDid, book, syncAll, syncOne, adminSwitch, notify, config, DemoConfig, yearEnd, courseFor, untilSunday };
