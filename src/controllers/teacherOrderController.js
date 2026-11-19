// ➕ A teacher makes student accounts from the Teacher app and pays for them (owner 2026-11-19).
//  1. The teacher accepts the rules (once per rules version) — in the app, with their own login.
//  2. Chooses a course + plan (monthly / yearly) and adds students (one by one, or a list / Excel).
//  3. Price per student = the course price minus the सूट (discount) the admin set for this teacher
//     (percent or flat; none → full price). A student who already has this course running is only joined
//     to the teacher (not charged). (Stored on the teacher as commission_enabled / _mode / _value — the old
//     field names; it is a discount now, owner 2026-11-19: the word "commission" is not used anywhere.)
//  4. Pays online (Razorpay, on pay.html like a parent's payment). Only after the payment are the accounts
//     made (code = first 3 letters + last 4 mobile digits, PIN = last 4 digits — as the admin import), every
//     student joined to this teacher, Paper Builder unlimited for the course till the expiry.
//  5. The teacher gets the list (codes, PINs, the app link, the rules) as a PDF in the app.
// The teacher cannot edit or delete a student (the admin can). A teacher earns nothing on students' own
// payments (partnerCommission: shops only).
const { randomUUID } = require('crypto');
const User = require('../models/User');
const Batch = require('../models/Batch');
const StudentSubscription = require('../models/StudentSubscription');
const TeacherOrder = require('../models/TeacherOrder');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const razorpay = require('../utils/razorpay');
const { uniqueStudentCode } = require('../utils/studentCode');
const { RULES_VERSION, RULES } = require('../utils/teacherRules');
const { invalidateUserCache } = require('../middleware/auth');
const { sendToUser } = require('../utils/fcm');
const { _internal: IMPORT } = require('./studentImportController');

const MAX_ROWS = 200;
const APP_LINK = 'https://nkseduorbit.in/get-app';
const round2 = n => Math.round(Number(n) * 100) / 100;
const IST_MS = 5.5 * 3600e3;
const dayStart = day => new Date(`${day}T00:00:00.000Z`);
const dayEndIst = day => new Date(`${day}T23:59:59.000+05:30`);
const istDay = d => new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10);

function _teacherOf(req) {
  const t = req.userDoc;
  if (!t || t.role !== 'teacher') throw new AppError('Teacher access required', 403);
  if ((t.status || 'active') !== 'active') throw new AppError('तुमचं account अजून active नाही', 403);
  return t;
}
const rulesOk = t => t.rules_version_accepted === RULES_VERSION;

// the teacher's सूट (set by the admin on the teacher): { on, mode: 'percent' | 'flat', value } or null
function discountOf(teacher) {
  const v = Number(teacher.commission_value) || 0;
  return teacher.commission_enabled === true && v > 0 ? { mode: teacher.commission_mode === 'percent' ? 'percent' : 'flat', value: v } : null;
}
// the price for this teacher: course price − the सूट (percent / flat), never below 0
function priceFor(teacher, batch, plan) {
  const list = Number(plan === 'monthly' ? batch.monthly_price : batch.yearly_price) || 0;
  const d = discountOf(teacher);
  const off = d ? round2(Math.min(list, d.mode === 'percent' ? (list * d.value) / 100 : d.value)) : 0;
  const rule = d ? (d.mode === 'percent' ? `${d.value}%` : `₹${d.value}`) : '';
  return { list, discount: off, rule, unit: round2(Math.max(0, list - off)) };
}

// the students (validated, matched with existing accounts, codes chosen) and the money
async function _plan(teacher, body, now = new Date()) {
  const batchName = String(body.batch || '').trim();
  const plan = body.plan === 'monthly' ? 'monthly' : body.plan === 'yearly' ? 'yearly' : '';
  if (!plan) throw new AppError('Plan निवडा: Monthly किंवा Yearly', 400);
  const batch = await Batch.findOne({ name: batchName, is_active: { $ne: false } }).lean();
  if (!batch) throw new AppError('Course निवडा', 400);
  const rows = (Array.isArray(body.rows) ? body.rows : []).filter(r => r && (r.name || r.mobile));
  if (!rows.length) throw new AppError('किमान एक विद्यार्थी जोडा', 400);
  if (rows.length > MAX_ROWS) throw new AppError(`एका वेळी जास्तीत जास्त ${MAX_ROWS} विद्यार्थी`, 400);
  const price = priceFor(teacher, batch, plan);
  if (!(price.list > 0)) throw new AppError('या course ची किंमत ठरलेली नाही — admin ला सांगा', 400);

  // the admin import's own checks / matching / codes (no discount, this teacher)
  const planned = await IMPORT.planImport({
    rows: rows.map(r => ({ name: r.name, mobile: r.mobile, school: r.school })),
    defaults: { batches: [batch.name], plan, teacher_code: teacher.teacher_code, discount_percent: 0 },
  }, now);
  const existingIds = planned.rows.filter(r => r.existing_id).map(r => r.existing_id);
  const existing = new Map((await User.find({ user_id: { $in: existingIds } }, 'user_id assigned_batches expiry_date status').lean()).map(u => [u.user_id, u]));
  const out = planned.rows.map(r => {
    const base = { line: r.line, name: r.name, mobile: r.mobile, school: r.school, student_code: r.student_code, pin: r.pin, existing_id: r.existing_id, errors: r.errors, warnings: r.warnings };
    if (r.action === 'error') return { ...base, action: 'error', amount: 0 };
    const u = r.existing_id ? existing.get(r.existing_id) : null;
    // already has this course running → only joined, not charged
    const running = u && (u.assigned_batches || []).includes(batch.name) && u.expiry_date && new Date(u.expiry_date) > now;
    if (running) return { ...base, action: 'join', amount: 0, note: `आधीच ${istDay(u.expiry_date)} पर्यंत आहे — फक्त तुमच्याशी जोडला जाईल (पैसे नाहीत)` };
    return { ...base, action: r.action, amount: price.unit };
  });
  const ok = out.filter(r => r.action !== 'error');
  const charged = ok.filter(r => r.action !== 'join').length;
  return {
    batch: batch.name, plan, expiry: IMPORT.planExpiryDay(plan, now), price, rows: out,
    summary: { total: out.length, ok: ok.length, errors: out.length - ok.length, create: ok.filter(r => r.action === 'create').length, update: ok.filter(r => r.action === 'update').length, join: ok.filter(r => r.action === 'join').length, charged, amount: round2(charged * price.unit) },
  };
}

// GET /api/teacher-orders/setup — rules status, courses with this teacher's prices, past orders
exports.setup = asyncHandler(async (req, res) => {
  const t = _teacherOf(req);
  const batches = await Batch.find({ is_active: { $ne: false } }, 'name monthly_price yearly_price').sort({ name: 1 }).lean();
  const orders = await TeacherOrder.find({ teacher_user_id: t.user_id }).sort({ created_at: -1 }).limit(30).lean();
  res.json({ success: true, data: {
    rules: { accepted: rulesOk(t), version: RULES_VERSION, accepted_at: t.rules_accepted_at || null, text: RULES },
    discount: discountOf(t),
    courses: batches.map(b => ({ name: b.name, monthly: priceFor(t, b, 'monthly'), yearly: priceFor(t, b, 'yearly') })).filter(c => c.monthly.list > 0 || c.yearly.list > 0),
    orders: orders.map(o => _orderView(o, false)),
    teacher: { name: t.name, code: t.teacher_code, institute: t.institute_name || '' },
    app_link: APP_LINK,
  } });
});

// POST /api/teacher-orders/accept-rules { version, agree: true } — in the app, with the teacher's own login
exports.acceptRules = asyncHandler(async (req, res) => {
  const t = _teacherOf(req);
  if (String(req.body.version || '') !== RULES_VERSION) throw new AppError('नियम बदलले आहेत — पुन्हा उघडा', 409);
  if (req.body.agree !== true) throw new AppError('नियम मान्य करण्यासाठी ☑ करा', 400);
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  await User.updateOne({ user_id: t.user_id, role: 'teacher' }, { $set: { rules_version_accepted: RULES_VERSION, rules_accepted_at: new Date(), rules_accepted_ip: ip.slice(0, 64) } });
  invalidateUserCache('teacher', t.user_id);
  res.json({ success: true, data: { accepted: true, version: RULES_VERSION } });
});

// POST /api/teacher-orders/preview { batch, plan, rows: [{ name, mobile, school }] }
exports.preview = asyncHandler(async (req, res) => {
  const t = _teacherOf(req);
  const p = await _plan(t, req.body || {});
  res.json({ success: true, data: { ...p, rows: p.rows.map(r => ({ ...r, pin: undefined })) } });
});

// POST /api/teacher-orders { batch, plan, rows } — the order; → Razorpay checkout (or done at once if nothing to pay)
exports.create = asyncHandler(async (req, res) => {
  const t = _teacherOf(req);
  if (!rulesOk(t)) throw new AppError('आधी नियम वाचून मान्य करा', 403);
  const p = await _plan(t, req.body || {});
  if (p.summary.errors) throw new AppError(`${p.summary.errors} विद्यार्थ्यांमध्ये चूक आहे — आधी दुरुस्त करा`, 400);
  const order = await TeacherOrder.create({
    order_no: 'TO-' + randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase(),
    teacher_user_id: t.user_id, teacher_code: t.teacher_code, teacher_name: t.name || '',
    batch: p.batch, plan: p.plan, expiry: p.expiry,
    list_price: p.price.list, discount: p.price.discount, discount_rule: p.price.rule, unit_price: p.price.unit,
    charged: p.summary.charged, amount: p.summary.amount,
    rows: p.rows.map(r => ({ name: r.name, mobile: r.mobile, school: r.school || '', action: r.action, existing_id: r.existing_id || '', student_code: r.student_code || '', pin: r.pin || '', amount: r.amount })),
  });
  // nothing to pay (everyone already has the course): join them now
  if (!(order.amount > 0)) {
    await fulfil(order._id);
    return res.status(201).json({ success: true, data: _orderView(await TeacherOrder.findById(order._id).lean(), true) });
  }
  if (!razorpay.isConfigured()) throw new AppError('Online payment सध्या बंद आहे — admin ला सांगा', 503);
  const rz = await razorpay.createOrder({
    amount: Math.round(order.amount * 100), currency: 'INR', receipt: order.order_no,
    notes: { type: 'teacher_students', order_no: order.order_no, teacher_code: t.teacher_code, students: String(order.charged) },
  });
  order.razorpay_order_id = rz.id;
  await order.save();
  res.status(201).json({ success: true, data: {
    ..._orderView(order.toObject(), false),
    checkout: { order_id: rz.id, amount: rz.amount, currency: rz.currency, key_id: razorpay.getKeyId(), name: t.name || '', contact: t.mobile || '',
      label: `${order.charged} विद्यार्थी · ${order.batch}` },
  } });
});

// GET /api/teacher-orders/:no — status (polled after the payment) and, once done, the students
exports.get = asyncHandler(async (req, res) => {
  const t = _teacherOf(req);
  const o = await TeacherOrder.findOne({ order_no: String(req.params.no || ''), teacher_user_id: t.user_id }).lean();
  if (!o) throw new AppError('Order सापडली नाही', 404);
  // paid but not finished (the server restarted mid-way): finish now
  if (o.status === 'paid' && Date.now() - new Date(o.updated_at).getTime() > 60e3) await fulfil(o._id).catch(() => {});
  res.json({ success: true, data: _orderView(await TeacherOrder.findById(o._id).lean(), true) });
});

function _orderView(o, withRows) {
  return {
    order_no: o.order_no, batch: o.batch, plan: o.plan, expiry: o.expiry, status: o.status,
    list_price: o.list_price, discount: o.discount, discount_rule: o.discount_rule, unit_price: o.unit_price,
    charged: o.charged, students: o.rows.length, amount: o.amount, created_at: o.created_at, done_at: o.done_at,
    ...(withRows && o.status === 'done' ? { rows: o.rows.map(r => ({ name: r.name, mobile: r.mobile, student_code: r.student_code, pin: r.pin, action: r.action, status: r.status, error: r.error })) } : {}),
  };
}

// ── after the payment (pay.html → /payment/verify-public, or Razorpay's webhook) ──
async function markPaid(razorpayOrderId, paymentId) {
  const o = await TeacherOrder.findOneAndUpdate(
    { razorpay_order_id: razorpayOrderId, status: 'created' },
    { $set: { status: 'paid', razorpay_payment_id: paymentId, paid_at: new Date() } },
    { new: true });
  if (o) await fulfil(o._id);
  return !!o;
}

// make / extend the accounts, join them to the teacher — safe to run again (same keys)
const _running = new Set();
async function fulfil(orderId) {
  const id = String(orderId);
  if (_running.has(id)) return;
  _running.add(id);
  try {
    const o = await TeacherOrder.findById(id);
    if (!o || o.status === 'done' || (o.status === 'created' && o.amount > 0)) return;
    const teacher = await User.findOne({ user_id: o.teacher_user_id, role: 'teacher' });
    if (!teacher) return;
    const now = new Date();
    const codes = new Set();
    for (const r of o.rows) {
      if (r.status && r.status !== 'error') { if (r.student_code) codes.add(r.student_code); continue; }
      try {
        let student;
        if (r.action === 'create') {
          // the code chosen at order time may have been taken since
          const again = await User.findOne({ role: 'student', mobile: r.mobile, student_code: r.student_code }).lean();
          if (again) student = await User.findById(again._id);
          else {
            if (await User.exists({ student_code: r.student_code })) r.student_code = await uniqueStudentCode(r.name, r.mobile, async c => !!(await User.exists({ student_code: c })));
            student = await User.create({
              user_id: `student-${randomUUID()}`, name: r.name, role: 'student', student_code: r.student_code, mobile: r.mobile,
              status: 'active', assigned_batches: [o.batch], expiry_date: dayStart(o.expiry), pin_hash: User.hashPin(r.pin),
              approved_at: now, approved_by: `teacher:${o.teacher_code}`, request_source: 'teacher', school_name: r.school,
              referred_by_teacher: o.teacher_code, free_tier: false,
            });
          }
        } else {
          student = await User.findOne({ user_id: r.existing_id, role: 'student' });
          if (!student) throw new Error('विद्यार्थी सापडला नाही');
          if (r.action === 'update') {
            student.assigned_batches = [...new Set([...(student.assigned_batches || []), o.batch])];
            if (!student.expiry_date || dayStart(o.expiry) > student.expiry_date) student.expiry_date = dayStart(o.expiry);
            if (student.status === 'pending') { student.status = 'active'; student.approved_at = now; }
            if (!student.referred_by_teacher) student.referred_by_teacher = o.teacher_code;
            student.free_tier = false;
            await student.save();
          }
        }
        invalidateUserCache('student', student.user_id);
        if (r.action !== 'join' && r.amount > 0) {
          const key = `tord:${o.order_no}:${student.student_code}`;
          await StudentSubscription.findOneAndUpdate({ razorpay_payment_id: key }, { $setOnInsert: {
            student_user_id: student.user_id, student_code: student.student_code, batch: o.batch, period: o.plan,
            amount: r.amount, list_price: o.list_price, razorpay_order_id: o.razorpay_order_id, razorpay_payment_id: key,
            payment_verified: true, status: 'active', is_trial: false, start_date: now, expiry_date: dayEndIst(o.expiry),
            source: 'teacher_bulk', paid_by_teacher: o.teacher_code,
            discount_applied_percent: o.list_price ? Math.min(100, round2((o.discount / o.list_price) * 100)) : 0,
            discount_source: o.discount ? 'teacher_discount' : '',
          } }, { upsert: true, new: true });
        }
        r.student_code = student.student_code;
        r.status = r.action === 'create' ? 'created' : r.action === 'update' ? 'updated' : 'joined';
        r.error = '';
        codes.add(student.student_code);
      } catch (err) {
        r.status = 'error'; r.error = err.code === 11000 ? 'Code आधीच वापरात' : String(err.message || err).slice(0, 200);
      }
    }
    // everyone joins this teacher; Paper Builder unlimited for the course till the expiry (if anyone paid)
    teacher.assigned_students = [...new Set([...(teacher.assigned_students || []), ...codes])];
    if (o.charged > 0) {
      const unlimited = new Map((teacher.paper_unlimited || []).map(e => [e.batch, new Date(e.until)]));
      const until = dayEndIst(o.expiry);
      if (!unlimited.has(o.batch) || unlimited.get(o.batch) < until) unlimited.set(o.batch, until);
      teacher.paper_unlimited = [...unlimited].map(([batch, u]) => ({ batch, until: u }));
    }
    await teacher.save();
    invalidateUserCache('teacher', teacher.user_id);
    o.status = 'done'; o.done_at = new Date();
    o.markModified('rows');
    await o.save();
    if (teacher.device_token) {
      sendToUser(teacher.device_token, '🎉 विद्यार्थी तयार झाले!', `${codes.size} विद्यार्थी ${o.batch} साठी तयार आणि तुमच्याशी जोडले. Code / PIN चा PDF app मध्ये.`, { type: 'teacher_order', order_no: o.order_no }).catch(() => {});
    }
  } finally { _running.delete(id); }
}

exports.markPaid = markPaid;
exports.fulfil = fulfil;
exports._plan = _plan;
exports.priceFor = priceFor;
