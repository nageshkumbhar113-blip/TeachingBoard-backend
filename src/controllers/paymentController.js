const User = require('../models/User');
const Batch = require('../models/Batch');
const StudentSubscription = require('../models/StudentSubscription');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const razorpay = require('../utils/razorpay');
const { sendToUser } = require('../utils/fcm');

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

// ── Verify payment synchronously from the Checkout success handler ───────────
// Body: { student_code, pin, razorpay_order_id, razorpay_payment_id, razorpay_signature }
// This does not replace the webhook (kept as an idempotent backup) — it gives
// an immediate activation path that does not depend on Razorpay's webhook
// delivery reaching this server (webhook URL misconfiguration, retries, etc.
// would otherwise leave a paying student stuck in "pending").

exports.verifyPayment = asyncHandler(async (req, res) => {
  const student = await authStudentByPin(req.body.student_code, req.body.pin);

  const orderId    = String(req.body.razorpay_order_id   || '').trim();
  const paymentId  = String(req.body.razorpay_payment_id || '').trim();
  const signature  = String(req.body.razorpay_signature  || '').trim();
  if (!orderId || !paymentId || !signature) {
    throw new AppError('razorpay_order_id, razorpay_payment_id and razorpay_signature are required', 400);
  }

  if (!razorpay.verifyPaymentSignature(orderId, paymentId, signature)) {
    throw new AppError('Payment verification failed', 400);
  }

  const sub = await StudentSubscription.findOne({ razorpay_order_id: orderId, student_user_id: student.user_id });
  if (!sub) throw new AppError('Order not found', 404);

  if (sub.payment_verified) {
    return res.json({ success: true, message: 'Already verified', student: { status: student.status } });
  }

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

  res.json({ success: true, message: 'Payment verified', student: { status: student.status, expiry_date: student.expiry_date } });
});

// ── Verify payment WITHOUT a PIN (external-browser checkout flow) ────────────
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// The student's PIN can't safely travel to an external browser tab (would
// show up in URLs/browser history), so this endpoint relies purely on
// Razorpay's signature as proof — the same trust model the webhook already
// uses below. order_id ties the payment back to exactly one student via the
// StudentSubscription row created at order time; nothing else identifies
// "who" here, which is fine since only Razorpay can produce a valid signature
// for a given order_id + payment_id pair.
exports.verifyPaymentPublic = asyncHandler(async (req, res) => {
  const orderId   = String(req.body.razorpay_order_id   || '').trim();
  const paymentId = String(req.body.razorpay_payment_id || '').trim();
  const signature = String(req.body.razorpay_signature  || '').trim();
  if (!orderId || !paymentId || !signature) {
    throw new AppError('razorpay_order_id, razorpay_payment_id and razorpay_signature are required', 400);
  }

  if (!razorpay.verifyPaymentSignature(orderId, paymentId, signature)) {
    throw new AppError('Payment verification failed', 400);
  }

  const sub = await StudentSubscription.findOne({ razorpay_order_id: orderId });
  if (!sub) throw new AppError('Order not found', 404);

  if (sub.payment_verified) {
    return res.json({ success: true, message: 'Already verified' });
  }

  const student = await User.findOne({ user_id: sub.student_user_id, role: 'student' });
  if (!student) throw new AppError('Student not found', 404);

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

  res.json({ success: true, message: 'Payment verified' });
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

    // YouTube Teacher Partner subscriptions share this one webhook (no new
    // Render service) — distinguished by order.notes.type, set at order-create
    // time in youtubeTeacherPaymentController.createSubscriptionOrder.
    if (paymentEntity?.notes?.type === 'youtube_teacher_subscription') {
      const YoutubeTeacherSubscription = require('../models/YoutubeTeacherSubscription');
      const ytSub = await YoutubeTeacherSubscription.findOne({ razorpay_order_id: orderId });
      if (!ytSub) return res.status(200).json({ success: true, message: 'Ignored (unknown order)' });
      if (ytSub.payment_verified) return res.status(200).json({ success: true, message: 'Already processed' });

      ytSub.razorpay_payment_id = paymentId;
      ytSub.payment_verified = true;
      ytSub.status = 'active';
      ytSub.start_date = new Date();
      ytSub.expiry_date = YoutubeTeacherSubscription.computeExpiry(ytSub.plan_type, new Date());
      await ytSub.save();

      return res.status(200).json({ success: true, message: 'Payment processed' });
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

// ── Admin: students who started a paid checkout but never completed it ───────
// A Razorpay order is written as status:'created' the moment the student
// picks a plan; it only flips to 'active' after verifyPayment/webhook. Any
// 'created' row still sitting there after a grace period is a real drop-off
// — a lead who showed buying intent for a specific paid plan, worth calling.
exports.getPendingPayments = asyncHandler(async (req, res) => {
  const GRACE_MS = 15 * 60 * 1000; // ignore attempts from the last 15 min — likely still mid-checkout
  const cutoff = new Date(Date.now() - GRACE_MS);

  const abandoned = await StudentSubscription.find({
    status: 'created',
    period: { $in: ['monthly', 'yearly'] },
    created_at: { $lte: cutoff },
  }).sort({ created_at: -1 }).limit(200).lean();

  if (!abandoned.length) return res.json({ success: true, data: [] });

  const userIds = [...new Set(abandoned.map(s => s.student_user_id))];
  const students = await User.find({ user_id: { $in: userIds } })
    .select('user_id name mobile student_code status assigned_batches')
    .lean();
  const studentMap = new Map(students.map(s => [s.user_id, s]));

  // A student who backs out and retries the same batch (common — they
  // reopen the plan screen, pick a plan, bail again) writes a NEW 'created'
  // row each time via createOrder, since orders are never reused/updated.
  // Collapse those into one follow-up entry per student+batch, keeping the
  // most recent attempt (abandoned is already sorted created_at desc).
  const seen = new Set();
  const data = abandoned
    .map(sub => {
      const student = studentMap.get(sub.student_user_id);
      if (!student) return null;
      // Already has access to this batch (this attempt or a later retry
      // succeeded) — nothing to follow up on.
      if ((student.assigned_batches || []).includes(sub.batch)) return null;
      const dedupeKey = `${sub.student_user_id}|${sub.batch}`;
      if (seen.has(dedupeKey)) return null;
      seen.add(dedupeKey);
      return {
        student_code: student.student_code,
        name: student.name,
        mobile: student.mobile,
        batch: sub.batch,
        period: sub.period,
        amount: sub.amount,
        started_at: sub.created_at,
      };
    })
    .filter(Boolean);

  res.json({ success: true, data });
});

// ── Admin: revenue summary (total / today / this month) ──────────────────────
// Sums the `amount` of every verified payment. created_at is used as the
// revenue date — Razorpay orders are captured within minutes of creation in
// this flow, so it's an accurate enough proxy without a separate paid_at field.
exports.getRevenueSummary = asyncHandler(async (req, res) => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const sum = async match => {
    const rows = await StudentSubscription.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return rows[0]?.total || 0;
  };

  const [total, today, month] = await Promise.all([
    sum({ payment_verified: true }),
    sum({ payment_verified: true, created_at: { $gte: startOfToday } }),
    sum({ payment_verified: true, created_at: { $gte: startOfMonth } }),
  ]);

  res.json({ success: true, data: { total, today, month } });
});

// ── CRON: Subscription expiry reminders (called by cron-job.org daily) ───────
// Same auth pattern as feeController.processReminders — a daily hit from an
// external scheduler, guarded by a shared secret. Fires once per student per
// expiry_date (expiry_notified_for tracks the last one notified), so it's
// safe to run daily across the whole D-8..D-0 window without re-spamming —
// but fires again after a renewal produces a new expiry_date.
exports.processExpiryReminders = asyncHandler(async (req, res) => {
  const secret   = String(req.headers['x-cron-secret'] || '').trim();
  const expected = String(process.env.CRON_SECRET || '').trim();
  if (!expected || secret !== expected) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + 8);

  const students = await User.find({
    role: 'student',
    status: 'active',
    expiry_date: { $gte: now, $lte: windowEnd },
    device_token: { $exists: true, $nin: [null, ''] },
  }).lean();

  let notified = 0;
  for (const student of students) {
    const already = student.expiry_notified_for &&
      new Date(student.expiry_notified_for).getTime() === new Date(student.expiry_date).getTime();
    if (already) continue;

    const daysLeft = Math.max(0, Math.ceil((new Date(student.expiry_date) - now) / 86400000));
    const title = '⏰ Subscription लवकरच संपणार आहे';
    const body  = daysLeft > 0
      ? `${student.name} ची subscription ${daysLeft} दिवसात संपेल. वेळेत renew करा, अन्यथा access बंद होईल.`
      : `${student.name} ची subscription आज संपते. वेळेत renew करा.`;

    await sendToUser(student.device_token, title, body, {
      type: 'subscription_expiry',
      student_code: student.student_code,
      days_left: String(daysLeft),
    }).catch(err => console.warn('Expiry FCM error:', err.message));

    await User.updateOne({ user_id: student.user_id }, { $set: { expiry_notified_for: student.expiry_date } });
    notified++;
  }

  res.json({ success: true, notified_count: notified, checked: students.length });
});
