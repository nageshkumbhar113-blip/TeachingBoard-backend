const SubscriberClaim    = require('../models/SubscriberClaim');
const YoutubeTeacherPartner = require('../models/YoutubeTeacherPartner');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { sendToUser } = require('../utils/fcm');
const { invalidateUserCache } = require('../middleware/auth');

function serializeClaim(c, partner) {
  return {
    id: String(c._id),
    student_code: c.student_code,
    youtube_display_name: c.youtube_display_name,
    status: c.status,
    claimed_at: c.claimed_at,
    partner: partner ? { id: String(partner._id), name: partner.name, youtube_channel_url: partner.youtube_channel_url || '' } : undefined,
  };
}

// ── Student-facing (requireStudent) ──────────────────────────────────────────

// GET /api/youtube-teacher/subscriber-search?q=
// Typeahead: onboarded, active YouTube Teacher Partners by name/channel name.
exports.searchPartners = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) return res.json({ success: true, data: [] });

  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const partners = await YoutubeTeacherPartner.find({
    status: 'active',
    $or: [{ name: re }, { youtube_channel_name: re }],
  })
    .select('name youtube_channel_url youtube_channel_name profile_photo')
    .limit(20)
    .lean();

  res.json({
    success: true,
    data: partners.map(p => ({
      id: String(p._id),
      name: p.name,
      youtube_channel_name: p.youtube_channel_name || '',
      youtube_channel_url: p.youtube_channel_url || '',
      profile_photo: p.profile_photo || '',
    })),
  });
});

// GET /api/youtube-teacher/subscriber-claim/status
// The logged-in student's own verification/claim state, for the plan-select
// screen to decide what to show (entry point / pending / discount active).
exports.getMyClaimStatus = asyncHandler(async (req, res) => {
  const student = req.userDoc;
  if (student.youtube_sub_verified_for_partner) {
    const partner = await YoutubeTeacherPartner.findById(student.youtube_sub_verified_for_partner).select('name').lean();
    return res.json({
      success: true,
      data: { state: 'verified', partner_name: partner?.name || '', verified_at: student.youtube_sub_verified_at },
    });
  }

  const pending = await SubscriberClaim.findOne({ student_user_id: student.user_id, status: 'pending' })
    .sort({ claimed_at: -1 })
    .lean();
  if (pending) {
    const partner = await YoutubeTeacherPartner.findById(pending.partner_id).select('name').lean();
    return res.json({ success: true, data: { state: 'pending', partner_name: partner?.name || '' } });
  }

  res.json({ success: true, data: { state: 'none' } });
});

// POST /api/youtube-teacher/subscriber-claim  { partner_id, youtube_display_name }
exports.claimSubscriber = asyncHandler(async (req, res) => {
  const student = req.userDoc;
  if (student.youtube_sub_verified_for_partner) {
    throw new AppError('Already verified — discount is already active', 400);
  }

  const partnerId = String(req.body.partner_id || '').trim();
  const displayName = String(req.body.youtube_display_name || '').trim().slice(0, 120);
  if (!partnerId) throw new AppError('partner_id is required', 400);
  if (!displayName) throw new AppError('तुमचं YouTube नाव टाका', 400);

  const partner = await YoutubeTeacherPartner.findOne({ _id: partnerId, status: 'active' });
  if (!partner) throw new AppError('Teacher not found', 404);

  const existingPending = await SubscriberClaim.findOne({ student_user_id: student.user_id, status: 'pending' });
  if (existingPending) throw new AppError('तुमची आधीच एक request pending आहे', 400);

  const claim = await SubscriberClaim.create({
    student_user_id: student.user_id,
    student_code: student.student_code,
    partner_id: partner._id,
    youtube_display_name: displayName,
    status: 'pending',
  });

  res.status(201).json({ success: true, data: serializeClaim(claim, partner) });
});

// ── Teacher-facing (requireYoutubeTeacher) ───────────────────────────────────

// GET /api/youtube-teacher/subscriber-claims?status=pending
exports.listMyClaims = asyncHandler(async (req, res) => {
  const filter = { partner_id: req.user.id };
  const status = String(req.query.status || '').trim();
  if (['pending', 'approved', 'rejected'].includes(status)) filter.status = status;

  const claims = await SubscriberClaim.find(filter).sort({ claimed_at: -1 }).limit(200).lean();
  res.json({ success: true, data: claims.map(c => serializeClaim(c)) });
});

// POST /api/youtube-teacher/subscriber-claims/:id/approve
exports.approveClaim = asyncHandler(async (req, res) => {
  const claim = await SubscriberClaim.findOne({ _id: req.params.id, partner_id: req.user.id });
  if (!claim) throw new AppError('Claim not found', 404);
  if (claim.status !== 'pending') throw new AppError('Claim already reviewed', 400);

  claim.status = 'approved';
  claim.reviewed_at = new Date();
  claim.reviewed_by = req.user.id;
  await claim.save();

  const student = await User.findOne({ user_id: claim.student_user_id, role: 'student' });
  if (student) {
    student.youtube_sub_verified_for_partner = claim.partner_id;
    student.youtube_sub_verified_at = new Date();
    await student.save();
    invalidateUserCache('student', student.user_id);

    await sendToUser(
      student.device_token,
      '🎉 50% Discount Unlocked!',
      'तुमचं YouTube subscription verify झालं — आता subscription वर 50% सूट लागू आहे.',
      { type: 'youtube_subscriber_discount' }
    ).catch(err => console.warn('Discount-approval FCM error:', err.message));
  }

  res.json({ success: true, data: serializeClaim(claim) });
});

// POST /api/youtube-teacher/subscriber-claims/:id/reject
exports.rejectClaim = asyncHandler(async (req, res) => {
  const claim = await SubscriberClaim.findOne({ _id: req.params.id, partner_id: req.user.id });
  if (!claim) throw new AppError('Claim not found', 404);
  if (claim.status !== 'pending') throw new AppError('Claim already reviewed', 400);

  claim.status = 'rejected';
  claim.reviewed_at = new Date();
  claim.reviewed_by = req.user.id;
  await claim.save();

  res.json({ success: true, data: serializeClaim(claim) });
});
