const { randomUUID, randomInt } = require('crypto');
const User = require('../models/User');
const GuestLead = require('../models/GuestLead');
const ShopInvite = require('../models/ShopInvite');
const CommissionEntry = require('../models/CommissionEntry');
const StudentSubscription = require('../models/StudentSubscription');
const PayoutStatement = require('../models/PayoutStatement');
const { monthKey, ensurePreviousMonthClosed, getConfig } = require('../utils/partnerCommission');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { isWeakPin } = require('../utils/pin');
const { normalizeMobile } = require('./guestController');
const { invalidateUserCache } = require('../middleware/auth');

// Guide / book shops (docs/PLAN_shop_partners.md). A shop is a teacher account
// with partner_type 'shop', made only by the admin; it shares the free test and
// the app, and earns the commission the admin set on payments of its students.

const UPI_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

const _clean = (v, max = 80) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const _mask = m => (m && m.length === 10 ? `${m.slice(0, 2)}XXXXX${m.slice(-3)}` : '');

function _percent(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new AppError(`${field}: 0 ते 100 मधला % द्या`, 400);
  return Math.round(n * 100) / 100;
}

function _newPin() {
  let pin;
  do { pin = String(randomInt(1000, 10000)); } while (isWeakPin(pin));
  return pin;
}

async function _newCode(shopName) {
  const prefix = 'SH' + (shopName.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'OP');
  for (let i = 0; i < 20; i++) {
    const code = prefix + String(randomInt(100, 1000));
    if (!(await User.exists({ $or: [{ teacher_code: code }, { student_code: code }] }))) return code;
  }
  throw new AppError('Shop code तयार झाला नाही, पुन्हा प्रयत्न करा', 500);
}

function _shopView(s) {
  return {
    id: s.user_id,
    code: s.teacher_code,
    owner: s.name,
    shop_name: s.institute_name || '',
    area: s.shop_area || '',
    mobile: s.mobile || '',
    status: s.status || 'active',
    first_percent: s.commission_value || 0,
    renewal_percent: s.commission_first_payment_only === false ? (s.commission_value || 0) : (s.commission_renewal_value || 0),
    upi_id: s.payout_upi_id || '',
    upi_name: s.payout_name || '',
    created_at: s.created_at || null,
    last_login_at: s.last_login_at || null,
  };
}

// Students of a shop with paid status and what the shop earned on each.
async function _students(shop, limit = 500) {
  const rows = await User.find({ role: 'student', referred_by_teacher: shop.teacher_code })
    .select('name student_code mobile assigned_batches created_at').sort({ created_at: -1 }).limit(limit).lean();
  const codes = rows.map(r => r.student_code);
  const [subs, comm] = await Promise.all([
    StudentSubscription.find({ student_code: { $in: codes }, payment_verified: true, is_trial: false }, 'student_code amount period created_at').lean(),
    CommissionEntry.find({ partner_user_id: shop.user_id, status: 'active' }, 'student_code amount type').lean(),
  ]);
  const paid = new Map();
  subs.forEach(s => {
    const p = paid.get(s.student_code) || { total: 0, last: null, period: '' };
    p.total += Number(s.amount) || 0;
    if (!p.last || s.created_at > p.last) { p.last = s.created_at; p.period = s.period; }
    paid.set(s.student_code, p);
  });
  const earned = new Map();
  comm.forEach(e => earned.set(e.student_code, (earned.get(e.student_code) || 0) + e.amount));
  return rows.map(r => ({
    name: r.name,
    code: r.student_code,
    class: (r.assigned_batches || [])[0] || '',
    mobile: _mask(r.mobile),
    _mobile: r.mobile,
    joined_at: r.created_at,
    paid: paid.has(r.student_code),
    paid_amount: paid.get(r.student_code)?.total || 0,
    period: paid.get(r.student_code)?.period || '',
    paid_at: paid.get(r.student_code)?.last || null,
    earned: Math.round((earned.get(r.student_code) || 0) * 100) / 100,
  }));
}

async function _summary(shop) {
  const code = shop.teacher_code;
  const [invites, visitors, tested, students, earnedAgg] = await Promise.all([
    ShopInvite.countDocuments({ shop_code: code }),
    GuestLead.countDocuments({ source: 'shop', ref: code }),
    GuestLead.countDocuments({ source: 'shop', ref: code, tests: { $gt: 0 } }),
    User.find({ role: 'student', referred_by_teacher: code }).select('student_code').lean(),
    CommissionEntry.aggregate([{ $match: { partner_user_id: shop.user_id, status: 'active' } }, { $group: { _id: null, t: { $sum: '$amount' } } }]),
  ]);
  const codes = students.map(s => s.student_code);
  const paid = codes.length ? (await StudentSubscription.distinct('student_code', { student_code: { $in: codes }, payment_verified: true, is_trial: false })).length : 0;
  return { invites, visitors, tested, accounts: codes.length, paid, earned: Math.round((earnedAgg[0]?.t || 0) * 100) / 100 };
}

// Month-by-month account (settlement) of a shop: the running month (lines not yet
// in a statement) and every closed monthly statement with its payout.
async function _settlement(shop) {
  await ensurePreviousMonthClosed();
  const now = new Date();
  const [open, statements, cfg] = await Promise.all([
    CommissionEntry.find({ partner_user_id: shop.user_id, status: 'active', statement_id: '' }, 'type amount payable_at').lean(),
    PayoutStatement.find({ partner_user_id: shop.user_id }).sort({ month: -1 }).limit(24).lean(),
    getConfig(),
  ]);
  const sum = rows => Math.round(rows.reduce((t, e) => t + e.amount, 0) * 100) / 100;
  const hold = open.filter(e => e.payable_at > now);
  return {
    hold_days: cfg.hold_days,
    min_payout: cfg.min_payout,
    running: {
      month: monthKey(now),
      count: open.filter(e => e.type === 'commission').length,
      amount: sum(open),
      hold_amount: sum(hold),
    },
    months: statements.map(st => ({
      id: String(st._id),
      month: st.month,
      count: st.new_count,
      amount: st.new_amount,
      adjust: st.adjust_amount,
      carried_in: st.carried_in,
      net: st.net,
      status: st.status,
      carried_to: st.carried_to || '',
      upi_id: st.upi_id || '',
      upi_name: st.upi_name || '',
      paid_at: st.paid_at,
      utr: st.utr || '',
    })),
    paid_total: Math.round(statements.filter(st => st.status === 'paid').reduce((t, st) => t + st.net, 0) * 100) / 100,
  };
}

function _requireShop(req) {
  if (req.userDoc?.partner_type !== 'shop') throw new AppError('हे page फक्त दुकानांसाठी आहे', 403);
  return req.userDoc;
}

// ── Shop panel ──────────────────────────────────────────────────────────────

// GET /api/shop/me — everything the shop panel shows.
exports.me = asyncHandler(async (req, res) => {
  const shop = _requireShop(req);
  const code = shop.teacher_code;
  const [summary, students, leads, invites, settlement] = await Promise.all([
    _summary(shop),
    _students(shop, 300),
    GuestLead.find({ source: 'shop', ref: code }, 'name batch tests best_pct parent_mobile converted_code last_seen_at created_at').sort({ last_seen_at: -1 }).limit(200).lean(),
    ShopInvite.find({ shop_code: code }).sort({ last_at: -1 }).limit(200).lean(),
    _settlement(shop),
  ]);
  const byMobile = new Map(students.map(s => [s._mobile, s]));
  const leadByMobile = new Map(leads.filter(l => l.parent_mobile).map(l => [l.parent_mobile, l]));
  res.json({
    success: true,
    data: {
      shop: _shopView(shop),
      summary,
      settlement,
      students: students.map(({ _mobile, ...s }) => s),
      visitors: leads.filter(l => !l.converted_code).map(l => ({
        name: l.name || '', class: l.batch || '', tests: l.tests || 0, best_pct: l.best_pct || 0,
        mobile: _mask(l.parent_mobile), last_seen_at: l.last_seen_at,
      })),
      invites: invites.map(i => {
        const st = byMobile.get(i.mobile);
        const lead = leadByMobile.get(i.mobile);
        const step = st ? (st.paid ? 'paid' : 'account') : lead ? (lead.tests > 0 ? 'tested' : 'opened') : 'sent';
        return { mobile: i.mobile, count: i.count, last_at: i.last_at, step, name: st?.name || lead?.name || '' };
      }),
    },
  });
});

// POST /api/shop/me/invite { mobile } — the shopkeeper sent the link to this parent.
exports.invite = asyncHandler(async (req, res) => {
  const shop = _requireShop(req);
  const mobile = normalizeMobile(req.body?.mobile);
  if (!mobile) throw new AppError('पालकांचा योग्य 10 अंकी नंबर लिहा', 400);
  if (mobile === shop.mobile) throw new AppError('हा तुमचाच नंबर आहे — पालकांचा नंबर लिहा', 400);
  await ShopInvite.updateOne(
    { shop_code: shop.teacher_code, mobile },
    { $inc: { count: 1 }, $set: { last_at: new Date() } },
    { upsert: true },
  );
  res.json({ success: true, mobile });
});

// ── Admin ───────────────────────────────────────────────────────────────────

// GET /api/shop/admin/shops
exports.adminList = asyncHandler(async (_req, res) => {
  const shops = await User.find({ role: 'teacher', partner_type: 'shop' }).sort({ created_at: -1 }).lean();
  const data = await Promise.all(shops.map(async s => ({ ..._shopView(s), summary: await _summary(s) })));
  res.json({ success: true, data });
});

// GET /api/shop/admin/shops/:id/students
exports.adminStudents = asyncHandler(async (req, res) => {
  const shop = await User.findOne({ user_id: req.params.id, role: 'teacher', partner_type: 'shop' }).lean();
  if (!shop) throw new AppError('Shop सापडलं नाही', 404);
  const rows = await _students(shop);
  res.json({ success: true, data: rows.map(({ _mobile, ...s }) => ({ ...s, mobile: _mobile })) });
});

// GET /api/shop/admin/shops/:id/settlement — monthly account of one shop.
exports.adminSettlement = asyncHandler(async (req, res) => {
  const shop = await User.findOne({ user_id: req.params.id, role: 'teacher', partner_type: 'shop' }).lean();
  if (!shop) throw new AppError('Shop सापडलं नाही', 404);
  res.json({ success: true, data: await _settlement(shop) });
});

// POST /api/shop/admin/shops — new shop; the PIN is returned once.
exports.adminCreate = asyncHandler(async (req, res) => {
  const owner = _clean(req.body?.owner, 60);
  const shopName = _clean(req.body?.shop_name, 80);
  const area = _clean(req.body?.area, 80);
  const mobile = normalizeMobile(req.body?.mobile);
  if (!shopName) throw new AppError('दुकानाचं नाव लिहा', 400);
  if (!owner) throw new AppError('मालकाचं नाव लिहा', 400);
  if (!mobile) throw new AppError('योग्य 10 अंकी mobile नंबर लिहा', 400);
  const first = _percent(req.body?.first_percent, 'पहिलं payment');
  const renewal = _percent(req.body?.renewal_percent ?? 0, 'Renewal');
  if (await User.exists({ role: 'teacher', partner_type: 'shop', mobile })) throw new AppError('या नंबरचं दुकान आधीच आहे', 409);
  let pin = String(req.body?.pin || '').trim();
  if (pin) {
    if (isWeakPin(pin)) throw new AppError('PIN 4 अंकी आणि अवघड हवा (1234, 1111 नको)', 400);
  } else pin = _newPin();
  const upi = String(req.body?.upi_id || '').trim().toLowerCase();
  if (upi && !UPI_RE.test(upi)) throw new AppError('UPI ID चुकीचा आहे (उदा. name@bank)', 400);

  const shop = await User.create({
    user_id: `teacher-${randomUUID()}`,
    name: owner,
    role: 'teacher',
    teacher_code: await _newCode(shopName),
    mobile,
    institute_name: shopName,
    shop_area: area,
    partner_type: 'shop',
    commission_enabled: true,
    commission_mode: 'percent',
    commission_value: first,
    commission_first_payment_only: true,
    commission_renewal_value: renewal,
    payout_upi_id: upi,
    payout_name: upi ? _clean(req.body?.upi_name, 80) || owner : '',
    status: 'active',
    request_source: 'admin',
    approved_at: new Date(),
    approved_by: String(req.user?.id || 'admin'),
    assigned_students: [],
    pin_hash: User.hashPin(pin),
  });
  res.status(201).json({ success: true, data: _shopView(shop), pin });
});

// PUT /api/shop/admin/shops/:id — edit; { reset_pin: true } returns a new PIN.
exports.adminUpdate = asyncHandler(async (req, res) => {
  const shop = await User.findOne({ user_id: req.params.id, role: 'teacher', partner_type: 'shop' });
  if (!shop) throw new AppError('Shop सापडलं नाही', 404);
  const b = req.body || {};
  if (b.owner !== undefined) { const v = _clean(b.owner, 60); if (!v) throw new AppError('मालकाचं नाव लिहा', 400); shop.name = v; }
  if (b.shop_name !== undefined) { const v = _clean(b.shop_name, 80); if (!v) throw new AppError('दुकानाचं नाव लिहा', 400); shop.institute_name = v; }
  if (b.area !== undefined) shop.shop_area = _clean(b.area, 80);
  if (b.mobile !== undefined) {
    const m = normalizeMobile(b.mobile);
    if (!m) throw new AppError('योग्य 10 अंकी mobile नंबर लिहा', 400);
    if (m !== shop.mobile && await User.exists({ role: 'teacher', partner_type: 'shop', mobile: m })) throw new AppError('या नंबरचं दुकान आधीच आहे', 409);
    shop.mobile = m;
  }
  if (b.first_percent !== undefined) shop.commission_value = _percent(b.first_percent, 'पहिलं payment');
  if (b.renewal_percent !== undefined) { shop.commission_renewal_value = _percent(b.renewal_percent, 'Renewal'); shop.commission_first_payment_only = true; }
  if (b.status !== undefined) {
    if (!['active', 'blocked'].includes(b.status)) throw new AppError('status active किंवा blocked', 400);
    shop.status = b.status;
    shop.commission_enabled = b.status === 'active';
  }
  if (b.upi_id !== undefined) {
    const upi = String(b.upi_id || '').trim().toLowerCase();
    if (upi && !UPI_RE.test(upi)) throw new AppError('UPI ID चुकीचा आहे (उदा. name@bank)', 400);
    shop.payout_upi_id = upi;
    if (b.upi_name !== undefined) shop.payout_name = _clean(b.upi_name, 80);
    else if (upi && !shop.payout_name) shop.payout_name = shop.name;
  }
  let pin = '';
  if (b.reset_pin === true) { pin = _newPin(); shop.pin_hash = User.hashPin(pin); }
  await shop.save();
  invalidateUserCache('teacher', shop.user_id);
  res.json({ success: true, data: _shopView(shop), ...(pin ? { pin } : {}) });
});
