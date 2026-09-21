const User = require('../models/User');
const CommissionEntry = require('../models/CommissionEntry');
const PayoutStatement = require('../models/PayoutStatement');
const PartnerConfig = require('../models/PartnerConfig');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const {
  getConfig, monthKey, previousMonthKey, reverseEntry, closeMonth, ensurePreviousMonthClosed,
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

exports.getPartnerConfig = asyncHandler(async (_req, res) => {
  const cfg = await getConfig();
  res.json({ success: true, data: { hold_days: cfg.hold_days, min_payout: cfg.min_payout, youtube_flat: cfg.youtube_flat, school_percent: cfg.school_percent } });
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
  await PartnerConfig.updateOne({ key: 'main' }, { $set: patch }, { upsert: true });
  const cfg = await getConfig();
  res.json({ success: true, data: { hold_days: cfg.hold_days, min_payout: cfg.min_payout, youtube_flat: cfg.youtube_flat, school_percent: cfg.school_percent } });
});

// ── Admin: overview of every partner's running balance ───────────────────────

exports.listPartners = asyncHandler(async (_req, res) => {
  const partners = await User.find({ role: 'teacher', $or: [{ commission_enabled: true }, { partner_type: { $in: ['school', 'youtube'] } }] }).lean();
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
