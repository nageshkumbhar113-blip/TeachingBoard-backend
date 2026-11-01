const User = require('../models/User');
const UsageDay = require('../models/UsageDay');
const UsageRequest = require('../models/UsageRequest');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { summaryOf } = require('./shopController');

// Who uses the app and how much (Admin > 📊 Usage) — to know whom to target
// next year. Phones keep their per-day totals (core/usage.js) and upload them
// only after the admin asks ("collect"), within the next 8 days. A resend of
// the same day only raises the numbers ($max), so it is safe to repeat.

const COLLECT_DAYS = 8;
const KEEP_DAYS = 400;
let _reqCache = null, _reqAt = 0;
async function _request() {
  if (_reqCache && Date.now() - _reqAt < 60 * 1000) return _reqCache;
  _reqCache = (await UsageRequest.findOne({ key: 'main' }).lean()) || { requested_at: null, until: null };
  _reqAt = Date.now();
  return _reqCache;
}

const IST_MS = 5.5 * 3600 * 1000;
const FIELDS = ['minutes', 'opens', 'tests', 'notes', 'exercise', 'words', 'weekly', 'papers', 'notifs', 'invites'];
const LIMIT = { minutes: 24 * 60, opens: 500, tests: 300, notes: 500, exercise: 500, words: 2000, weekly: 20, papers: 200, notifs: 200, invites: 500 };

const istDate = (d = new Date()) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);

function _who(req) {
  const u = req.userDoc;
  if (!u || req.user?.guest) throw new AppError('Login required', 401);
  if (u.role === 'student') return { role: 'student', code: u.student_code };
  if (u.role === 'teacher') return { role: u.partner_type === 'shop' ? 'shop' : 'teacher', code: u.teacher_code };
  throw new AppError('Not counted', 403);
}

// GET /api/usage/collect — is there an open request? (phones ask at most twice a day; memory-cached)
exports.collect = asyncHandler(async (_req, res) => {
  const r = await _request();
  const open = r.until && new Date(r.until) > new Date();
  res.set('Cache-Control', 'private, max-age=600');
  res.json({ success: true, requested_at: open ? r.requested_at : null, until: open ? r.until : null });
});

// POST /api/usage/daily { days: [{ date, minutes, tests, ... }] } — the stored days (sent in chunks).
exports.daily = asyncHandler(async (req, res) => {
  const who = _who(req);
  const days = Array.isArray(req.body?.days) ? req.body.days.slice(0, 120) : [];
  const today = istDate();
  const oldest = istDate(new Date(Date.now() - KEEP_DAYS * 864e5));
  const ops = [];
  for (const d of days) {
    const date = String(d?.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today || date < oldest) continue;
    const max = {};
    for (const f of FIELDS) {
      const v = Math.floor(Number(d[f]) || 0);
      if (v > 0) max[f] = Math.min(v, LIMIT[f]);
    }
    if (!Object.keys(max).length) continue;
    ops.push({
      updateOne: {
        filter: { code: who.code, date },
        update: { $setOnInsert: { role: who.role, day_at: new Date(`${date}T00:00:00+05:30`) }, $set: { uploaded_at: new Date() }, $max: max },
        upsert: true,
      },
    });
  }
  if (ops.length) await UsageDay.bulkWrite(ops, { ordered: false });
  res.json({ success: true, saved: ops.length });
});

function _plan(s, now) {
  if (s.free_tier) return 'free';
  if (!s.expiry_date) return 'paid';
  const left = new Date(s.expiry_date) - now;
  if (left < 0) return 'expired';
  return left < 15 * 864e5 ? 'expiring' : 'paid';
}

// POST /api/usage/admin/collect — ask every phone to upload within the next 8 days.
exports.adminCollect = asyncHandler(async (_req, res) => {
  const now = new Date();
  const r = await UsageRequest.findOneAndUpdate({ key: 'main' }, { $set: { requested_at: now, until: new Date(now.getTime() + COLLECT_DAYS * 864e5) } }, { upsert: true, new: true }).lean();
  _reqCache = r; _reqAt = Date.now();
  res.json({ success: true, requested_at: r.requested_at, until: r.until });
});

// GET /api/usage/admin?role=student|teacher|shop&days=30
exports.admin = asyncHandler(async (req, res) => {
  const role = ['student', 'teacher', 'shop'].includes(req.query.role) ? req.query.role : 'student';
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 400);
  const since = istDate(new Date(Date.now() - (days - 1) * 864e5));
  const now = new Date();

  const agg = await UsageDay.aggregate([
    { $match: { role, date: { $gte: since } } },
    { $group: {
      _id: '$code', active_days: { $sum: 1 }, last_date: { $max: '$date' },
      ...Object.fromEntries(FIELDS.map(f => [f, { $sum: `$${f}` }])),
    } },
  ]);
  const use = new Map(agg.map(a => [a._id, a]));
  const lastEver = new Map((await UsageDay.aggregate([
    { $match: { role } }, { $group: { _id: '$code', last: { $max: '$date' } } },
  ])).map(a => [a._id, a.last]));
  const usageOf = code => {
    const a = use.get(code) || {};
    return { active_days: a.active_days || 0, ...Object.fromEntries(FIELDS.map(f => [f, a[f] || 0])), last_used: lastEver.get(code) || '' };
  };

  let rows;
  if (role === 'student') {
    const students = await User.find({ role: 'student' }).select('name student_code mobile assigned_batches free_tier expiry_date status created_at referred_by_teacher').lean();
    rows = students.map(s => ({
      code: s.student_code, name: s.name, mobile: s.mobile || '', class: (s.assigned_batches || [])[0] || '',
      plan: _plan(s, now), expiry: s.expiry_date || null, status: s.status || 'active', joined: s.created_at || null,
      via: s.referred_by_teacher || '', ...usageOf(s.student_code),
    }));
  } else if (role === 'teacher') {
    const teachers = await User.find({ role: 'teacher', partner_type: { $ne: 'shop' } }).select('name teacher_code mobile partner_type institute_name status assigned_students last_login_at created_at').lean();
    rows = teachers.map(t => ({
      code: t.teacher_code, name: t.name, mobile: t.mobile || '', type: t.partner_type || 'school', place: t.institute_name || '',
      status: t.status || 'active', students: (t.assigned_students || []).length, last_login: t.last_login_at || null, joined: t.created_at || null,
      ...usageOf(t.teacher_code),
    }));
  } else {
    const shops = await User.find({ role: 'teacher', partner_type: 'shop' }).lean();
    rows = await Promise.all(shops.map(async s => ({
      code: s.teacher_code, name: s.institute_name || s.name, owner: s.name, mobile: s.mobile || '', place: s.shop_area || '',
      status: s.status || 'active', last_login: s.last_login_at || null, joined: s.created_at || null,
      ...usageOf(s.teacher_code), summary: await summaryOf(s),
    })));
  }
  const r = await _request();
  const answered = r.requested_at ? (await UsageDay.distinct('code', { role, uploaded_at: { $gte: new Date(r.requested_at) } })).length : 0;
  res.json({ success: true, role, days, since, data: rows, collect: { requested_at: r.requested_at, until: r.until, answered } });
});
