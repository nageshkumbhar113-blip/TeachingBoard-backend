const User = require('../models/User');
const Batch = require('../models/Batch');
const StudentSubscription = require('../models/StudentSubscription');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const razorpay = require('../utils/razorpay');

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeCode(v) { return String(v || '').trim().toUpperCase(); }

// Authenticate a student by code + PIN (works even when login is blocked
// for pending/expired accounts, which is exactly when they need to pay).
async function authStudentByPin(studentCode, pin) {
  const code = normalizeCode(studentCode);
  const student = await User.findOne({ student_code: code, role: 'student' });
  if (!student || !student.verifyPin(String(pin || '').trim())) {
    // 403 (not 401): the frontend's request() treats 401 as "session expired"
    // and triggers a global re-login popup, which would disrupt the pay flow.
    throw new AppError('Invalid student code or PIN', 403);
  }
  if (student.status === 'blocked') {
    throw new AppError('Account is blocked', 403);
  }
  return student;
}

// Resolve a paid, active batch and the price for the chosen period.
async function resolvePaidBatch(batchName, period) {
  const batch = await Batch.findOne({ name: String(batchName || '').trim() });
  if (!batch) throw new AppError('Batch not found', 404);
  if (batch.is_active === false) throw new AppError('Batch is not available', 403);

  const price = period === 'yearly' ? batch.yearly_price : batch.monthly_price;
  if (!price || price <= 0) {
    throw new AppError(`This batch has no ${period} price configured`, 400);
  }
  return { batch, price };
}

// Extend access: active status, ensure batch assigned, push expiry forward.
async function activateStudentForBatch(student, batchName, newExpiry) {
  student.status = 'active';
  if (!Array.isArray(student.assigned_batches)) student.assigned_batches = [];
  if (!student.assigned_batches.includes(batchName)) {
    student.assigned_batches.push(batchName);
  }
  // Never shorten an existing longer subscription
  if (!student.expiry_date || newExpiry > student.expiry_date) {
    student.expiry_date = newExpiry;
  }
  if (!student.approved_at) {
    student.approved_at = new Date();
    student.approved_by = 'payment';
  }
  await student.save();
}

// ── Public config (frontend needs the key id to open Checkout) ────────────────

exports.getConfig = asyncHandler(async (_req, res) => {
  res.json({
    success: true,
    configured: razorpay.isConfigured(),
    key_id: razorpay.getKeyId(),
  });
});

// ── Create a Razorpay order (student_code + PIN authenticated) ────────────────
// Body: { student_code, pin, batch, period: 'monthly' | 'yearly' }

exports.createOrder = asyncHandler(async (req, res) => {
  const period = String(req.body.period || '').trim();
  if (!['monthly', 'yearly'].includes(period)) {
    throw new AppError('period must be "monthly" or "yearly"', 400);
  }

  const student = await authStudentByPin(req.body.student_code, req.body.pin);
  const { batch, price } = await resolvePaidBatch(req.body.batch, period);

  // Server computes the amount — never trust the client.
  const order = await razorpay.createOrder({
    amount: price * 100, // paise
    currency: 'INR',
    receipt: `tb_${student.student_code}_${Date.now()}`,
    notes: {
      student_code: student.student_code,
      student_user_id: student.user_id,
      batch: batch.name,
      period,
    },
  });

  await StudentSubscription.create({
    student_user_id: student.user_id,
    student_code: student.student_code,
    batch: batch.name,
    period,
    amount: price,
    currency: 'INR',
    razorpay_order_id: order.id,
    status: 'created',
    is_trial: false,
  });

  res.status(201).json({
    success: true,
    order_id: order.id,
    amount: order.amount, // paise
    currency: order.currency,
    key_id: razorpay.getKeyId(),
    batch: batch.name,
    period,
    prefill: { name: student.name, contact: student.mobile || '' },
  });
});

// ── Start a free trial (1 day) for a batch ────────────────────────────────────
// Body: { student_code, pin, batch }

exports.startTrial = asyncHandler(async (req, res) => {
  const student = await authStudentByPin(req.body.student_code, req.body.pin);
  const batch = await Batch.findOne({ name: String(req.body.batch || '').trim() });
  if (!batch) throw new AppError('Batch not found', 404);
  if (batch.is_active === false) throw new AppError('Batch is not available', 403);

  const trialDays = batch.trial_days != null ? batch.trial_days : 1;
  if (trialDays <= 0) throw new AppError('No free trial available for this batch', 400);

  // One trial per student per batch
  const existingTrial = await StudentSubscription.findOne({
    student_user_id: student.user_id,
    batch: batch.name,
    is_trial: true,
  });
  if (existingTrial) throw new AppError('Free trial already used for this batch', 409);

  const start = new Date();
  const expiry = StudentSubscription.computeExpiry('trial', start, trialDays);

  await StudentSubscription.create({
    student_user_id: student.user_id,
    student_code: student.student_code,
    batch: batch.name,
    period: 'trial',
    amount: 0,
    razorpay_order_id: '',
    payment_verified: true,
    status: 'active',
    is_trial: true,
    start_date: start,
    expiry_date: expiry,
  });

  await activateStudentForBatch(student, batch.name, expiry);

  res.status(201).json({
    success: true,
    message: `Free trial started (${trialDays} day${trialDays > 1 ? 's' : ''})`,
    batch: batch.name,
    expiry_date: expiry,
  });
});

// ── Razorpay webhook (public; verified by signature on RAW body) ──────────────

exports.webhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  // req.rawBody is captured by the express.json verify hook in app.js
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

  if (!razorpay.verifyWebhookSignature(rawBody, signature)) {
    return res.status(400).json({ success: false, message: 'Invalid signature' });
  }

  const event = req.body?.event;
  const paymentEntity = req.body?.payload?.payment?.entity;

  // Only act on successful payment events
  if (event === 'payment.captured' || event === 'order.paid') {
    const orderId = paymentEntity?.order_id;
    const paymentId = paymentEntity?.id;
    if (!orderId || !paymentId) {
      return res.status(200).json({ success: true, message: 'Ignored (no order/payment id)' });
    }

    const sub = await StudentSubscription.findOne({ razorpay_order_id: orderId });
    if (!sub) {
      return res.status(200).json({ success: true, message: 'Ignored (unknown order)' });
    }

    // Idempotent — Razorpay retries webhooks; do not double-process
    if (sub.payment_verified) {
      return res.status(200).json({ success: true, message: 'Already processed' });
    }

    const student = await User.findOne({ user_id: sub.student_user_id, role: 'student' });
    if (!student) {
      return res.status(200).json({ success: true, message: 'Ignored (student gone)' });
    }

    // Extend from the later of now / current expiry so renewals stack
    const base = (student.expiry_date && student.expiry_date > new Date())
      ? student.expiry_date
      : new Date();
    const expiry = StudentSubscription.computeExpiry(sub.period, base);

    sub.razorpay_payment_id = paymentId;
    sub.payment_verified = true;
    sub.status = 'active';
    sub.start_date = new Date();
    sub.expiry_date = expiry;
    await sub.save();

    await activateStudentForBatch(student, sub.batch, expiry);

    return res.status(200).json({ success: true, message: 'Payment processed' });
  }

  // Acknowledge other events so Razorpay stops retrying
  return res.status(200).json({ success: true, message: 'Event ignored' });
});

// ── Subscription status for a student (code + PIN) ────────────────────────────
// Body: { student_code, pin }

exports.getStatus = asyncHandler(async (req, res) => {
  const student = await authStudentByPin(req.body.student_code, req.body.pin);
  const subs = await StudentSubscription.find({ student_user_id: student.user_id })
    .sort({ created_at: -1 })
    .lean();

  res.json({
    success: true,
    student: {
      student_code: student.student_code,
      status: student.status,
      expiry_date: student.expiry_date,
      assigned_batches: student.assigned_batches || [],
    },
    subscriptions: subs.map(s => ({
      batch: s.batch,
      period: s.period,
      amount: s.amount,
      status: s.status,
      is_trial: s.is_trial,
      payment_verified: s.payment_verified,
      start_date: s.start_date,
      expiry_date: s.expiry_date,
    })),
  });
});
