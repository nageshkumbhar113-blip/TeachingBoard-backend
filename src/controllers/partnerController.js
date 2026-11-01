const User = require('../models/User');
const CommissionEntry = require('../models/CommissionEntry');
const PayoutStatement = require('../models/PayoutStatement');
const PartnerConfig = require('../models/PartnerConfig');
const ReferralClaim = require('../models/ReferralClaim');
const StudentSubscription = require('../models/StudentSubscription');
const YoutubeTeacherSubscription = require('../models/YoutubeTeacherSubscription');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const {
  getConfig, monthKey, monthRange, previousMonthKey, reverseEntry, closeMonth, settlePartnerNow, ensurePreviousMonthClosed,
} = require('../utils/partnerCommission');
const { invalidateUserCache } = require('../middleware/auth');

const UPI_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const maskPan = pan => (pan && pan.length === 10 ? `${pan.slice(0, 2)}******${pan.slice(-2)}` : '');

function serializeStatement(s) {
  return {
    id: String(s._id),
    partner_user_id: s.partner_user_id,
    partner_code: s.partner_code,
    partner_name: s.partner_name,
    month: s.month,
    new_count: s.new_count,
    new_amount: s.new_amount,
    adjust_count: s.adjust_count,
    adjust_amount: s.adjust_amount,
    carried_in: s.carried_in,
    net: s.net,
    min_payout: s.min_payout,
    status: s.status,
    carried_to: s.carried_to || '',
    upi_id: s.upi_id,
    upi_name: s.upi_name,
    closed_at: s.closed_at,
    paid_at: s.paid_at,
    utr: s.utr,
  };
}

function serializeEntry(e) {
  return {
    id: String(e._id),
    type: e.type,
    status: e.status,
    partner_user_id: e.partner_user_id,
    partner_code: e.partner_code,
    student_code: e.student_code,
    amount_paid: e.amount_paid,
    mode: e.mode,
    rate: e.rate,
    amount: e.amount,
    paid_at: e.paid_at,
    payable_at: e.payable_at,
    payable_month: e.payable_month,
    in_statement: !!e.statement_id,
    note: e.note,
  };
}

// ── Admin: settings ───────────────────────────────────────────────────────────

const configView = cfg => ({
  hold_days: cfg.hold_days, min_payout: cfg.min_payout, youtube_flat: cfg.youtube_flat, school_percent: cfg.school_percent,
  prize_delivery_days: cfg.prize_delivery_days || 10,
  prizes: (cfg.prizes || []).map(p => ({ count: p.count, title: p.title })),
  student_discount_enabled: cfg.student_discount_enabled !== false,
  student_discount_percent: cfg.student_discount_percent ?? 50,
  student_discount_first_payment_only: cfg.student_discount_first_payment_only !== false,
});

exports.getPartnerConfig = asyncHandler(async (_req, res) => {
  const cfg = await getConfig();
  res.json({ success: true, data: configView(cfg) });
});

exports.setPartnerConfig = asyncHandler(async (req, res) => {
  const patch = {};
  const num = (key, min, max) => {
    if (req.body[key] === undefined) return;
    const v = Number(req.body[key]);
    if (!Number.isFinite(v) || v < min || v > max) throw new AppError(`${key} must be between ${min} and ${max}`, 400);
    patch[key] = v;
  };
  num('hold_days', 0, 90);
  num('min_payout', 0, 100000);
  num('youtube_flat', 0, 10000);
  num('school_percent', 0, 100);
  num('prize_delivery_days', 1, 90);
  num('student_discount_percent', 0, 100);
  if (req.body.student_discount_enabled !== undefined) patch.student_discount_enabled = !!req.body.student_discount_enabled;
  if (req.body.student_discount_first_payment_only !== undefined) patch.student_discount_first_payment_only = !!req.body.student_discount_first_payment_only;
  if (req.body.prizes !== undefined) {
    if (!Array.isArray(req.body.prizes) || req.body.prizes.length > 8) throw new AppError('prizes must be a list of at most 8 items', 400);
    const seen = new Set();
    const prizes = req.body.prizes.map(p => {
      const count = Number(p?.count);
      const title = String(p?.title || '').trim().slice(0, 60);
      if (!Number.isInteger(count) || count < 1 || count > 1000) throw new AppError('Each prize needs a friend count between 1 and 1000', 400);
      if (!title) throw new AppError('Each prize needs a name', 400);
      if (seen.has(count)) throw new AppError('Two prizes cannot have the same friend count', 400);
      seen.add(count);
      return { count, title };
    }).sort((a, b) => a.count - b.count);
    patch.prizes = prizes;
  }
  await PartnerConfig.updateOne({ key: 'main' }, { $set: patch }, { upsert: true });
  const cfg = await getConfig();
  res.json({ success: true, data: configView(cfg) });
});

// ── Admin: overview of every partner's running balance ───────────────────────

exports.listPartners = asyncHandler(async (_req, res) => {
  const partners = await User.find({ role: 'teacher', $or: [{ commission_enabled: true }, { partner_type: { $in: ['school', 'youtube', 'shop'] } }] }).lean();
  const now = new Date();
  const open = await CommissionEntry.find({ status: 'active', statement_id: '' }).lean();
  const statements = await PayoutStatement.find({}).lean();
  const rows = partners.map(t => {
    const mine = open.filter(e => e.partner_user_id === t.user_id);
    const pending = mine.filter(e => e.payable_at > now);
    const payable = mine.filter(e => e.payable_at <= now);
    const st = statements.filter(s => s.partner_user_id === t.user_id);
    return {
      id: t.user_id,
      name: t.name,
      teacher_code: t.teacher_code,
      partner_type: t.partner_type || '',
      commission_enabled: t.commission_enabled === true,
      commission_mode: t.commission_mode || 'flat',
      commission_value: t.commission_value || 0,
      upi_id: t.payout_upi_id || '',
      upi_name: t.payout_name || '',
      pan: t.pan || '',
      pending_amount: pending.reduce((s, e) => s + e.amount, 0),
      pending_count: pending.length,
      payable_amount: payable.reduce((s, e) => s + e.amount, 0),
      payable_count: payable.length,
      paid_total: st.filter(s => s.status === 'paid').reduce((s, x) => s + x.net, 0),
      due_statements: st.filter(s => s.status === 'closed').length,
    };
  });
  res.json({ success: true, data: rows });
});

// ── Admin: statements ─────────────────────────────────────────────────────────

exports.listStatements = asyncHandler(async (req, res) => {
  await ensurePreviousMonthClosed();
  const filter = {};
  if (req.query.month) {
    if (!MONTH_RE.test(String(req.query.month))) throw new AppError('month must look like 2026-09', 400);
    filter.month = String(req.query.month);
  }
  if (req.query.status) filter.status = String(req.query.status);
  const rows = await PayoutStatement.find(filter).sort({ month: -1, partner_name: 1 }).limit(500).lean();
  res.json({ success: true, data: rows.map(serializeStatement), current_month: monthKey(new Date()), previous_month: previousMonthKey() });
});

exports.closeMonthNow = asyncHandler(async (req, res) => {
  const month = req.body.month ? String(req.body.month) : previousMonthKey();
  if (!MONTH_RE.test(month)) throw new AppError('month must look like 2026-09', 400);
  if (month >= monthKey(new Date())) throw new AppError('A month can only be closed after it has ended', 400);
  const created = await closeMonth(month, req.user?.id || 'admin');
  res.json({ success: true, month, created: created.length, data: created.map(serializeStatement) });
});

exports.markStatementPaid = asyncHandler(async (req, res) => {
  const stmt = await PayoutStatement.findById(req.params.id);
  if (!stmt) throw new AppError('Statement not found', 404);
  if (stmt.status !== 'closed') throw new AppError('Only a closed statement can be marked paid', 400);
  const utr = String(req.body.utr || '').trim();
  if (utr.length < 6) throw new AppError('Enter the UPI reference / UTR number', 400);
  stmt.status = 'paid';
  stmt.utr = utr.slice(0, 60);
  stmt.paid_at = new Date();
  stmt.paid_by = String(req.user?.id || 'admin');
  await stmt.save();
  res.json({ success: true, data: serializeStatement(stmt) });
});

// ── Admin: Settlement tab — everyone to pay this month + the financial year ──

// GET /api/partners/settlement?month=YYYY-MM&fy=2026
// month: which closed month to settle (default last month). fy: financial year
// starting April of that year (default the current one). Rows for every partner
// (school teacher / YouTube / shop) and every student with a prize request.
exports.settlementOverview = asyncHandler(async (req, res) => {
  await ensurePreviousMonthClosed();
  const now = new Date();
  const month = MONTH_RE.test(String(req.query.month || '')) ? String(req.query.month) : previousMonthKey(now);
  const [cy, cm] = monthKey(now).split('-').map(Number);
  const fyNow = cm >= 4 ? cy : cy - 1;
  const fy = /^\d{4}$/.test(String(req.query.fy || '')) ? Number(req.query.fy) : fyNow;
  const fyFrom = `${fy}-04`, fyTo = `${fy + 1}-03`;
  const fyStart = monthRange(fyFrom).start, fyEnd = monthRange(`${fy + 1}-04`).start;
  const cfg = await getConfig();

  const PARTNER_FIELDS = 'user_id name teacher_code partner_type mobile institute_name shop_area status payout_upi_id payout_name pan commission_mode commission_value';
  const [partners, open, stmts, fyEntries, lifeAgg, claims] = await Promise.all([
    User.find({ role: 'teacher', $or: [{ commission_enabled: true }, { partner_type: { $in: ['school', 'youtube', 'shop'] } }] })
      .select(PARTNER_FIELDS).lean(),
    CommissionEntry.find({ status: 'active', statement_id: '' }, 'partner_user_id type amount payable_at').lean(),
    PayoutStatement.find({}).lean(),
    CommissionEntry.find({ status: 'active', paid_at: { $gte: fyStart, $lt: fyEnd } }, 'partner_user_id type amount').lean(),
    // prizes asked in this year, plus any older one still waiting to be sent
    CommissionEntry.aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$partner_user_id', total: { $sum: '$amount' } } }]),
    ReferralClaim.find({ $or: [{ created_at: { $gte: fyStart, $lt: fyEnd } }, { status: 'requested' }] },
      'student_code student_name phone recipient_name address pincode title status created_at shipped_at tracking').sort({ created_at: -1 }).lean(),
  ]);

  // Money in (verified payments) and out (payouts marked paid) — month and year.
  const { start: mStart, end: mEnd } = monthRange(month);
  const inSum = async (Model, from, to) => {
    const rows = await Model.aggregate([
      { $match: { payment_verified: true, amount: { $gt: 0 }, created_at: { $gte: from, $lt: to } } },
      { $group: { _id: null, total: { $sum: '$amount' }, n: { $sum: 1 } } },
    ]);
    return { amount: rows[0]?.total || 0, count: rows[0]?.n || 0 };
  };
  const outSum = async (from, to) => {
    const rows = await PayoutStatement.aggregate([
      { $match: { status: 'paid', paid_at: { $gte: from, $lt: to } } },
      { $group: { _id: null, total: { $sum: '$net' }, n: { $sum: 1 } } },
    ]);
    return { amount: rows[0]?.total || 0, count: rows[0]?.n || 0 };
  };
  const [mStu, mYt, mOut, yStu, yYt, yOut] = await Promise.all([
    inSum(StudentSubscription, mStart, mEnd), inSum(YoutubeTeacherSubscription, mStart, mEnd), outSum(mStart, mEnd),
    inSum(StudentSubscription, fyStart, fyEnd), inSum(YoutubeTeacherSubscription, fyStart, fyEnd), outSum(fyStart, fyEnd),
  ]);
  const moneyOf = (stu, yt, out, earnedRows) => {
    const inn = stu.amount + yt.amount;
    return {
      in_students: stu.amount, in_students_count: stu.count,
      in_teachers: yt.amount, in_teachers_count: yt.count,
      in_total: Math.round(inn * 100) / 100,
      commission_earned: Math.round(earnedRows.reduce((t, e) => t + e.amount, 0) * 100) / 100,
      paid_out: Math.round(out.amount * 100) / 100, paid_out_count: out.count,
      net: Math.round((inn - out.amount) * 100) / 100,
    };
  };
  const monthEntries = await CommissionEntry.find({ status: 'active', paid_at: { $gte: mStart, $lt: mEnd } }, 'amount').lean();
  const r2 = n => Math.round(n * 100) / 100;
  const sum = (rows, f = x => x.amount) => r2(rows.reduce((t, x) => t + f(x), 0));

  const lifeOf = new Map(lifeAgg.map(x => [x._id, x.total]));
  // Anyone with money in the ledger is shown, even if commission was later turned off.
  const known = new Set(partners.map(t => t.user_id));
  const extraIds = [...new Set([...lifeAgg.map(x => x._id), ...stmts.map(st => st.partner_user_id)])].filter(id => id && !known.has(id));
  if (extraIds.length) {
    partners.push(...await User.find({ user_id: { $in: extraIds } }).select(PARTNER_FIELDS).lean());
    const found = new Set(partners.map(t => t.user_id));
    extraIds.filter(id => !found.has(id)).forEach(id => {
      const st = stmts.find(x => x.partner_user_id === id);
      partners.push({ user_id: id, name: `${st?.partner_name || 'Partner'} (account हटवलेलं)`, teacher_code: st?.partner_code || '', status: 'deleted' });
    });
  }
  const rows = partners.map(t => {
    const id = t.user_id;
    const mine = stmts.filter(st => st.partner_user_id === id);
    const m = mine.find(st => st.month === month) || null;
    const due = mine.filter(st => st.status === 'closed');
    const fyStmts = mine.filter(st => st.month >= fyFrom && st.month <= fyTo);
    const run = open.filter(e => e.partner_user_id === id);
    const earned = sum(fyEntries.filter(e => e.partner_user_id === id));
    // All-time account. Every active line ends up in exactly one bucket:
    // paid statements + closed (to pay) + carried (below the minimum, not yet
    // rolled into a later statement) + running (not yet in any statement).
    const lifePaid = sum(mine.filter(st => st.status === 'paid'), st => st.net);
    const lifeDue = sum(due, st => st.net);
    const lifeCarried = sum(mine.filter(st => st.status === 'carried' && !st.carried_to), st => st.net);
    const lifeRunning = sum(run);
    const lifeEarned = r2(lifeOf.get(id) || 0);
    return {
      id,
      name: t.partner_type === 'shop' ? (t.institute_name || t.name) : t.name,
      owner: t.name,
      code: t.teacher_code || '',
      type: t.partner_type || 'school',
      mobile: t.mobile || '',
      area: t.shop_area || t.institute_name || '',
      status: t.status || 'active',
      rate: t.commission_mode === 'percent' ? `${t.commission_value || 0}%` : `₹${t.commission_value || 0}`,
      upi_id: t.payout_upi_id || '',
      upi_name: t.payout_name || '',
      pan: !!t.pan,
      month: m ? { id: String(m._id), count: m.new_count, amount: m.new_amount, adjust: m.adjust_amount, carried_in: m.carried_in, net: m.net, status: m.status, utr: m.utr || '', paid_at: m.paid_at } : null,
      due: due.map(st => ({ id: String(st._id), month: st.month, net: st.net })),
      due_total: sum(due, st => st.net),
      running: { count: run.filter(e => e.type === 'commission').length, amount: sum(run), hold: sum(run.filter(e => e.payable_at > now)) },
      fy: {
        earned,
        paid: sum(fyStmts.filter(st => st.status === 'paid'), st => st.net),
        months_paid: fyStmts.filter(st => st.status === 'paid').length,
        payments: fyEntries.filter(e => e.partner_user_id === id && e.type === 'commission').length,
      },
      tds_warn: earned > 15000 && !t.pan,
      lifetime: {
        earned: lifeEarned, paid: lifePaid, due: lifeDue, carried: lifeCarried, running: lifeRunning,
        // what we still owe in total (closed + carried + running)
        owed: r2(lifeDue + lifeCarried + lifeRunning),
        balanced: Math.abs(lifeEarned - (lifePaid + lifeDue + lifeCarried + lifeRunning)) < 0.01,
      },
    };
  });

  const byStudent = new Map();
  claims.forEach(c => {
    const s = byStudent.get(c.student_code) || { code: c.student_code, name: c.student_name || '', mobile: c.phone || '', claims: [] };
    s.claims.push({
      id: String(c._id), title: c.title, status: c.status, requested_at: c.created_at, shipped_at: c.shipped_at, tracking: c.tracking || '',
      recipient: c.recipient_name || '', address: c.address || '', pincode: c.pincode || '', phone: c.phone || '',
    });
    byStudent.set(c.student_code, s);
  });
  const students = [...byStudent.values()].map(s => ({
    ...s,
    to_send: s.claims.filter(c => c.status === 'requested').length,
    sent: s.claims.filter(c => c.status === 'shipped').length,
  }));

  res.json({
    success: true,
    data: {
      month, current_month: monthKey(now), fy, fy_label: `${fy}-${String(fy + 1).slice(2)}`,
      min_payout: cfg.min_payout, hold_days: cfg.hold_days,
      money: { month: moneyOf(mStu, mYt, mOut, monthEntries), year: moneyOf(yStu, yYt, yOut, fyEntries) },
      totals: {
        month_due: sum(rows.filter(r => r.month?.status === 'closed'), r => r.month.net),
        month_paid: sum(rows.filter(r => r.month?.status === 'paid'), r => r.month.net),
        month_carried: sum(rows.filter(r => r.month?.status === 'carried'), r => r.month.net),
        all_due: sum(rows, r => r.due_total),
        life_paid: sum(rows, r => r.lifetime.paid),
        life_owed: sum(rows, r => r.lifetime.owed),
        life_earned: sum(rows, r => r.lifetime.earned),
        balanced: rows.every(r => r.lifetime.balanced),
        running: sum(rows, r => r.running.amount),
        fy_paid: sum(rows, r => r.fy.paid),
        fy_earned: sum(rows, r => r.fy.earned),
        prizes_to_send: students.reduce((t, s) => t + s.to_send, 0),
        prizes_sent: students.reduce((t, s) => t + s.sent, 0),
      },
      partners: rows,
      students,
    },
  });
});

// POST /api/partners/settlement/:id/settle-now — pay one partner before the 1st
// (everything past the hold). Returns the new statement to pay.
exports.settleNow = asyncHandler(async (req, res) => {
  const t = await User.findOne({ user_id: req.params.id, role: 'teacher' }).select('user_id').lean();
  if (!t) throw new AppError('Partner not found', 404);
  const r = await settlePartnerNow(t.user_id, String(req.user?.id || 'admin'));
  if (!r.ok) throw new AppError(r.message, 400);
  res.json({ success: true, data: serializeStatement(r.statement) });
});

// GET /api/partners/settlement/:id — one person's history: every monthly
// statement and every commission line (with the student's name).
exports.settlementHistory = asyncHandler(async (req, res) => {
  const t = await User.findOne({ user_id: req.params.id, role: 'teacher' }).select('user_id name institute_name partner_type teacher_code').lean();
  if (!t) throw new AppError('Partner not found', 404);
  const [statements, lines] = await Promise.all([
    PayoutStatement.find({ partner_user_id: t.user_id }).sort({ month: -1 }).limit(60).lean(),
    CommissionEntry.find({ partner_user_id: t.user_id }).sort({ paid_at: -1 }).limit(500).lean(),
  ]);
  const codes = [...new Set(lines.map(e => e.student_code).filter(Boolean))];
  const names = new Map((await User.find({ role: 'student', student_code: { $in: codes } }, 'student_code name assigned_batches').lean())
    .map(u => [u.student_code, { name: u.name, class: (u.assigned_batches || [])[0] || '' }]));
  res.json({
    success: true,
    data: {
      name: t.partner_type === 'shop' ? (t.institute_name || t.name) : t.name,
      code: t.teacher_code,
      statements: statements.map(serializeStatement),
      lines: lines.map(e => ({ ...serializeEntry(e), student_name: names.get(e.student_code)?.name || '', class: names.get(e.student_code)?.class || '' })),
    },
  });
});

// ── Admin: ledger lines ───────────────────────────────────────────────────────

exports.listCommissions = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.partner) filter.partner_user_id = String(req.query.partner);
  if (req.query.status) filter.status = String(req.query.status);
  const rows = await CommissionEntry.find(filter).sort({ created_at: -1 }).limit(500).lean();
  res.json({ success: true, data: rows.map(serializeEntry) });
});

exports.reverseCommission = asyncHandler(async (req, res) => {
  const result = await reverseEntry(req.params.id, String(req.body.reason || '').trim().slice(0, 200));
  if (!result.ok) throw new AppError(result.message, 400);
  res.json({ success: true, mode: result.mode });
});

// ── Cron (external scheduler, shared secret) ──────────────────────────────────

exports.cronCloseMonth = asyncHandler(async (req, res) => {
  const secret = String(req.headers['x-cron-secret'] || '').trim();
  const expected = String(process.env.CRON_SECRET || '').trim();
  if (!expected || secret !== expected) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const created = await closeMonth(previousMonthKey());
  res.json({ success: true, created: created.length });
});

// ── Partner (logged-in teacher): own earnings + payout details ───────────────

exports.getMyEarnings = asyncHandler(async (req, res) => {
  const t = req.userDoc;
  await ensurePreviousMonthClosed();
  const now = new Date();
  const [open, statements, all] = await Promise.all([
    CommissionEntry.find({ partner_user_id: t.user_id, status: 'active', statement_id: '' }).lean(),
    PayoutStatement.find({ partner_user_id: t.user_id }).sort({ month: -1 }).limit(24).lean(),
    CommissionEntry.find({ partner_user_id: t.user_id, type: 'commission', status: 'active' }).lean(),
  ]);
  const pending = open.filter(e => e.payable_at > now);
  const ready = open.filter(e => e.payable_at <= now);
  const cfg = await getConfig();
  res.json({
    success: true,
    data: {
      enabled: t.commission_enabled === true,
      partner_type: t.partner_type || '',
      mode: t.commission_mode || 'flat',
      value: t.commission_value || 0,
      first_payment_only: t.commission_first_payment_only !== false,
      hold_days: cfg.hold_days,
      min_payout: cfg.min_payout,
      current_month: monthKey(now),
      linked_students: Array.isArray(t.assigned_students) ? t.assigned_students.length : 0,
      paid_students: new Set(all.map(e => e.student_code)).size,
      pending: { count: pending.length, amount: pending.reduce((s, e) => s + e.amount, 0) },
      ready: { count: ready.length, amount: ready.reduce((s, e) => s + e.amount, 0) },
      statements: statements.map(serializeStatement),
      payout: { upi_id: t.payout_upi_id || '', upi_name: t.payout_name || '', pan: maskPan(t.pan || '') },
    },
  });
});

exports.setMyPayoutProfile = asyncHandler(async (req, res) => {
  const t = req.userDoc;
  const upi = String(req.body.upi_id || '').trim().toLowerCase();
  const confirm = String(req.body.upi_id_confirm || '').trim().toLowerCase();
  const name = String(req.body.upi_name || '').trim().slice(0, 80);
  const pan = String(req.body.pan || '').trim().toUpperCase();
  if (!UPI_RE.test(upi)) throw new AppError('Enter a valid UPI ID, for example name@bank', 400);
  if (upi !== confirm) throw new AppError('The two UPI IDs do not match', 400);
  if (!name) throw new AppError('Enter the name as it appears on the UPI account', 400);
  if (pan && !PAN_RE.test(pan)) throw new AppError('Enter a valid 10-character PAN, for example ABCDE1234F', 400);
  const doc = await User.findOne({ user_id: t.user_id, role: 'teacher' });
  doc.payout_upi_id = upi;
  doc.payout_name = name;
  if (pan) doc.pan = pan;
  await doc.save();
  invalidateUserCache('teacher', doc.user_id);
  res.json({ success: true, data: { upi_id: doc.payout_upi_id, upi_name: doc.payout_name, pan: maskPan(doc.pan || '') } });
});
