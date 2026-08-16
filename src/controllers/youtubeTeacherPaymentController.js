const YoutubeTeacherPartner      = require('../models/YoutubeTeacherPartner');
const YoutubeTeacherSubscription = require('../models/YoutubeTeacherSubscription');
const YoutubeTeacherPlanConfig   = require('../models/YoutubeTeacherPlanConfig');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const razorpay = require('../utils/razorpay');

// Server-side plan prices — never trust the client for amount. Admin-
// editable (Admin → YouTube Teachers → Plan Pricing), see
// YoutubeTeacherPlanConfig — this is just a thin rupees-to-paise reader.
async function _planPricePaise(planType, config) {
  const cfg = config || await YoutubeTeacherPlanConfig.getOrCreate();
  return { monthly: cfg.monthly_price, yearly: cfg.yearly_price }[planType] * 100;
}
async function _premiumAddonPaise(planType, config) {
  const cfg = config || await YoutubeTeacherPlanConfig.getOrCreate();
  return { monthly: cfg.premium_addon_monthly, yearly: cfg.premium_addon_yearly }[planType] * 100;
}

// POST /api/youtube-teacher/subscription/create  { plan_type, is_premium }
exports.createSubscriptionOrder = asyncHandler(async (req, res) => {
  const planType = String(req.body.plan_type || '').trim();
  const isPremium = !!req.body.is_premium;
  if (!['monthly', 'yearly'].includes(planType)) throw new AppError('plan_type must be "monthly" or "yearly"', 400);

  const partner = await YoutubeTeacherPartner.findById(req.user.id);
  if (!partner) throw new AppError('Account not found', 404);

  const config = await YoutubeTeacherPlanConfig.getOrCreate();
  const amountPaise = await _planPricePaise(planType, config) + (isPremium ? await _premiumAddonPaise(planType, config) : 0);

  const order = await razorpay.createOrder({
    amount: amountPaise,
    currency: 'INR',
    receipt: `ytt_${partner._id}_${Date.now()}`,
    notes: {
      type: 'youtube_teacher_subscription', // webhook branches on this — see paymentController.webhook
      youtube_teacher_id: String(partner._id),
      plan_type: planType,
      is_premium: isPremium ? '1' : '0',
    },
  });

  await YoutubeTeacherSubscription.create({
    youtube_teacher_id: partner._id,
    plan_type: planType,
    is_premium: isPremium,
    amount: amountPaise / 100,
    currency: 'INR',
    razorpay_order_id: order.id,
    status: 'created',
  });

  res.status(201).json({
    success: true,
    order_id: order.id,
    amount: order.amount,
    currency: order.currency,
    key_id: razorpay.getKeyId(),
    prefill: { name: partner.name, email: partner.email, contact: partner.mobile },
  });
});

// POST /api/youtube-teacher/subscription/verify
// { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Same signature-is-the-only-proof model as paymentController.verifyPaymentPublic
// — reasonable here too since the teacher is already authenticated via JWT
// for this call (unlike the student external-checkout case).
exports.verifySubscription = asyncHandler(async (req, res) => {
  const orderId   = String(req.body.razorpay_order_id   || '').trim();
  const paymentId = String(req.body.razorpay_payment_id || '').trim();
  const signature = String(req.body.razorpay_signature  || '').trim();
  if (!orderId || !paymentId || !signature) {
    throw new AppError('razorpay_order_id, razorpay_payment_id and razorpay_signature are required', 400);
  }
  if (!razorpay.verifyPaymentSignature(orderId, paymentId, signature)) {
    throw new AppError('Payment verification failed', 400);
  }

  const sub = await YoutubeTeacherSubscription.findOne({ razorpay_order_id: orderId, youtube_teacher_id: req.user.id });
  if (!sub) throw new AppError('Order not found', 404);
  if (sub.payment_verified) {
    return res.json({ success: true, message: 'Already verified' });
  }

  sub.razorpay_payment_id = paymentId;
  sub.razorpay_signature = signature;
  sub.payment_verified = true;
  sub.status = 'active';
  sub.start_date = new Date();
  sub.expiry_date = YoutubeTeacherSubscription.computeExpiry(sub.plan_type, new Date());
  await sub.save();

  res.json({ success: true, message: 'Payment verified', expiry_date: sub.expiry_date });
});

// GET /api/youtube-teacher/subscription
exports.getMySubscription = asyncHandler(async (req, res) => {
  const sub = await YoutubeTeacherSubscription.findOne({ youtube_teacher_id: req.user.id, status: 'active' }).sort({ created_at: -1 }).lean();
  res.json({ success: true, data: sub ? {
    plan_type: sub.plan_type, is_premium: sub.is_premium, status: sub.status,
    start_date: sub.start_date, expiry_date: sub.expiry_date,
  } : null });
});

// GET /api/youtube-teacher/payment-history
exports.getPaymentHistory = asyncHandler(async (req, res) => {
  const subs = await YoutubeTeacherSubscription.find({ youtube_teacher_id: req.user.id, payment_verified: true })
    .sort({ created_at: -1 }).lean();
  res.json({ success: true, data: subs.map(s => ({
    date: s.start_date || s.created_at,
    amount: s.amount, plan_type: s.plan_type, is_premium: s.is_premium, status: s.status,
  })) });
});

// POST /api/youtube-teacher/subscription/start-trial
exports.startTrial = asyncHandler(async (req, res) => {
  const existing = await YoutubeTeacherSubscription.findOne({ youtube_teacher_id: req.user.id, plan_type: 'trial' });
  if (existing) throw new AppError('Trial already used', 400);

  const config = await YoutubeTeacherPlanConfig.getOrCreate();
  const sub = await YoutubeTeacherSubscription.create({
    youtube_teacher_id: req.user.id,
    plan_type: 'trial',
    is_premium: false,
    amount: 0,
    status: 'active',
    payment_verified: true,
    start_date: new Date(),
    expiry_date: YoutubeTeacherSubscription.computeExpiry('trial', new Date(), config.trial_days),
  });
  res.status(201).json({ success: true, data: { expiry_date: sub.expiry_date } });
});

// GET /api/youtube-teacher/plan-config — PUBLIC, no auth. Read-only prices
// for the Landing page (shown before registration) and the in-dashboard
// plan picker. Never trust these on the server side for an actual charge —
// createSubscriptionOrder above re-reads the config itself.
exports.getPlanConfig = asyncHandler(async (_req, res) => {
  const cfg = await YoutubeTeacherPlanConfig.getOrCreate();
  res.json({
    success: true,
    data: {
      monthly_price: cfg.monthly_price,
      yearly_price: cfg.yearly_price,
      premium_addon_monthly: cfg.premium_addon_monthly,
      premium_addon_yearly: cfg.premium_addon_yearly,
      trial_days: cfg.trial_days,
    },
  });
});
