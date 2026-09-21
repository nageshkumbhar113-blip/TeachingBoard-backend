const User = require('../models/User');
const CommissionEntry = require('../models/CommissionEntry');
const PayoutStatement = require('../models/PayoutStatement');
const PartnerConfig = require('../models/PartnerConfig');

const IST_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_PRIZES = [{ count: 5, title: 'Compass box' }, { count: 8, title: 'Stationery kit' }, { count: 15, title: 'School bag' }];

async function getConfig() {
  let cfg = await PartnerConfig.findOne({ key: 'main' }).lean();
  if (!cfg) cfg = (await PartnerConfig.create({ key: 'main' })).toObject();
  // a settings document saved before prizes existed has no list yet
  if (!Array.isArray(cfg.prizes)) cfg = { ...cfg, prizes: DEFAULT_PRIZES };
  return cfg;
}

// 'YYYY-MM' of a moment, in Indian time
function monthKey(date) {
  const d = new Date(new Date(date).getTime() + IST_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// [start, end) of an IST month as real instants
function monthRange(key) {
  const [y, m] = key.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1) - IST_MS);
  const end = new Date(Date.UTC(y, m, 1) - IST_MS);
  return { start, end };
}

function previousMonthKey(now = new Date()) {
  const { start } = monthRange(monthKey(now));
  return monthKey(new Date(start.getTime() - DAY_MS));
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

// The active partner (teacher with commission on) a student's payment belongs to, or null.
async function findPartnerForStudent(student) {
  const code = String(student.student_code || '');
  let teacher = null;
  if (student.referred_by_teacher) {
    teacher = await User.findOne({ role: 'teacher', teacher_code: student.referred_by_teacher });
  }
  if (!teacher) {
    const linked = await User.find({ role: 'teacher', commission_enabled: true, assigned_students: code }).limit(2);
    if (linked.length === 1) teacher = linked[0];
  }
  if (!teacher || teacher.commission_enabled !== true) return null;
  if ((teacher.status || 'active') !== 'active') return null;
  return teacher;
}

function commissionFor(teacher, amountPaid) {
  const value = Number(teacher.commission_value) || 0;
  if (value <= 0) return 0;
  const raw = teacher.commission_mode === 'percent' ? (amountPaid * value) / 100 : value;
  return round2(Math.min(raw, amountPaid));
}

/**
 * Called after a student's payment is verified. Safe to call more than once for the same
 * payment (unique razorpay_payment_id) and never throws: a commission problem must not break
 * the student's payment flow.
 */
async function recordCommissionForPayment(sub, student) {
  try {
    if (!sub || !student || sub.is_trial || !(Number(sub.amount) > 0) || !sub.razorpay_payment_id) return null;
    if (await CommissionEntry.findOne({ razorpay_payment_id: sub.razorpay_payment_id }).lean()) return null;

    const teacher = await findPartnerForStudent(student);
    if (!teacher) return null;

    if (teacher.commission_first_payment_only !== false) {
      const earlier = await CommissionEntry.findOne({
        partner_user_id: teacher.user_id, student_code: student.student_code, type: 'commission', status: 'active',
      }).lean();
      if (earlier) return null;
    }

    const amount = commissionFor(teacher, Number(sub.amount));
    if (!(amount > 0)) return null;

    const cfg = await getConfig();
    const paidAt = new Date();
    const payableAt = new Date(paidAt.getTime() + (cfg.hold_days || 0) * DAY_MS);
    return await CommissionEntry.create({
      type: 'commission',
      partner_user_id: teacher.user_id,
      partner_code: teacher.teacher_code || '',
      student_code: student.student_code,
      student_user_id: student.user_id,
      subscription_id: String(sub._id),
      razorpay_payment_id: sub.razorpay_payment_id,
      amount_paid: Number(sub.amount),
      mode: teacher.commission_mode === 'percent' ? 'percent' : 'flat',
      rate: Number(teacher.commission_value) || 0,
      amount,
      paid_at: paidAt,
      payable_at: payableAt,
      payable_month: monthKey(payableAt),
    });
  } catch (err) {
    console.error('recordCommissionForPayment failed:', err.message);
    return null;
  }
}

/**
 * Cancels a commission. Before it is in a statement it is simply marked reversed; once it is in
 * a (closed) statement a negative adjustment is created, which goes into the next statement.
 */
async function reverseEntry(entryId, reason = '') {
  const entry = await CommissionEntry.findById(entryId);
  if (!entry || entry.type !== 'commission') return { ok: false, message: 'Commission not found' };
  if (entry.status === 'reversed') return { ok: false, message: 'Already reversed' };
  if (!entry.statement_id) {
    entry.status = 'reversed';
    entry.reversed_at = new Date();
    entry.note = reason || entry.note;
    await entry.save();
    return { ok: true, mode: 'cancelled' };
  }
  if (await CommissionEntry.findOne({ ref_entry_id: String(entry._id), type: 'adjustment' }).lean()) {
    return { ok: false, message: 'Already adjusted' };
  }
  const now = new Date();
  await CommissionEntry.create({
    type: 'adjustment',
    partner_user_id: entry.partner_user_id,
    partner_code: entry.partner_code,
    student_code: entry.student_code,
    student_user_id: entry.student_user_id,
    amount: -Math.abs(entry.amount),
    ref_entry_id: String(entry._id),
    note: reason || 'Refund / reversal',
    paid_at: now,
    payable_at: now,
    payable_month: monthKey(now),
  });
  return { ok: true, mode: 'adjustment' };
}

/**
 * Builds and locks the statement of every partner for one IST month. Idempotent: a partner that
 * already has a statement for that month is left alone.
 *   counted  = active commission/adjustment lines, not yet in a statement, payable before month end
 *   carried  = earlier statements that stayed below the minimum
 */
async function closeMonth(month, closedBy = 'system') {
  const { end } = monthRange(month);
  const cfg = await getConfig();

  const open = await CommissionEntry.find({
    status: 'active', statement_id: '', payable_at: { $lt: end },
  }).lean();
  const carriedRows = await PayoutStatement.find({ status: 'carried', carried_to: '', month: { $lt: month } }).lean();

  const partnerIds = new Set([...open.map(e => e.partner_user_id), ...carriedRows.map(s => s.partner_user_id)]);
  const created = [];

  for (const pid of partnerIds) {
    if (await PayoutStatement.findOne({ partner_user_id: pid, month }).lean()) continue;
    const teacher = await User.findOne({ user_id: pid, role: 'teacher' }).lean();
    const mine = open.filter(e => e.partner_user_id === pid);
    const commissions = mine.filter(e => e.type === 'commission');
    const adjustments = mine.filter(e => e.type === 'adjustment');
    const carriedFrom = carriedRows.filter(s => s.partner_user_id === pid);

    const newAmount = round2(commissions.reduce((t, e) => t + e.amount, 0));
    const adjustAmount = round2(adjustments.reduce((t, e) => t + e.amount, 0));
    const carriedIn = round2(carriedFrom.reduce((t, s) => t + s.net, 0));
    const net = round2(newAmount + adjustAmount + carriedIn);
    if (!mine.length && !carriedFrom.length) continue;

    const stmt = await PayoutStatement.create({
      partner_user_id: pid,
      partner_code: teacher?.teacher_code || '',
      partner_name: teacher?.name || '',
      month,
      new_count: commissions.length,
      new_amount: newAmount,
      adjust_count: adjustments.length,
      adjust_amount: adjustAmount,
      carried_in: carriedIn,
      net,
      min_payout: cfg.min_payout,
      status: net >= cfg.min_payout && net > 0 ? 'closed' : 'carried',
      upi_id: teacher?.payout_upi_id || '',
      upi_name: teacher?.payout_name || '',
      closed_at: new Date(),
      paid_by: closedBy === 'system' ? '' : String(closedBy),
    });
    if (mine.length) {
      await CommissionEntry.updateMany({ _id: { $in: mine.map(e => e._id) } }, { $set: { statement_id: String(stmt._id) } });
    }
    if (carriedFrom.length) {
      await PayoutStatement.updateMany({ _id: { $in: carriedFrom.map(s => s._id) } }, { $set: { carried_to: month } });
    }
    created.push(stmt);
  }
  return created;
}

// Lazy safety net: whenever the admin looks at statements, the previous month is closed if it was missed.
async function ensurePreviousMonthClosed() {
  const created = await closeMonth(previousMonthKey());
  return created.length;
}

module.exports = {
  getConfig, monthKey, monthRange, previousMonthKey,
  recordCommissionForPayment, reverseEntry, closeMonth, ensurePreviousMonthClosed,
};
