const User = require('../models/User');
const StudentSubscription = require('../models/StudentSubscription');
const ReferralClaim = require('../models/ReferralClaim');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { isValidMobile } = require('../utils/mobile');
const { getConfig } = require('../utils/partnerCommission');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A friend counts once he/she has a verified, paid (not trial) subscription that is older than the hold days
 * (so an early refund does not leave a prize behind). "pending" = paid but still inside the hold period.
 */
async function countFriends(studentCode) {
  const friends = await User.find({ role: 'student', referred_by_student: studentCode }).select('user_id student_code').lean();
  if (!friends.length) return { counted: 0, pending: 0, joined: 0 };
  const cfg = await getConfig();
  const cutoff = new Date(Date.now() - (cfg.hold_days || 0) * DAY_MS);
  const subs = await StudentSubscription.find({
    student_user_id: { $in: friends.map(f => f.user_id) },
    payment_verified: true, is_trial: false, amount: { $gt: 0 }, status: { $nin: ['cancelled', 'failed'] },
  }).select('student_user_id start_date created_at').lean();
  const firstPaid = new Map();
  for (const s of subs) {
    const at = s.start_date || s.created_at;
    const prev = firstPaid.get(s.student_user_id);
    if (!prev || at < prev) firstPaid.set(s.student_user_id, at);
  }
  let counted = 0;
  let pending = 0;
  for (const at of firstPaid.values()) { if (at <= cutoff) counted++; else pending++; }
  return { counted, pending, joined: friends.length };
}

const claimView = c => ({
  id: String(c._id), milestone: c.milestone, title: c.title, status: c.status,
  requested_at: c.created_at, shipped_at: c.shipped_at, tracking: c.tracking, note: c.note,
});

// GET /api/referrals/me  (student)
exports.getMyReferrals = asyncHandler(async (req, res) => {
  const s = req.userDoc;
  const [cfg, counts, claims] = await Promise.all([
    getConfig(),
    countFriends(s.student_code),
    ReferralClaim.find({ student_user_id: s.user_id }).lean(),
  ]);
  const byMilestone = new Map(claims.map(c => [c.milestone, c]));
  const milestones = (cfg.prizes || []).slice().sort((a, b) => a.count - b.count).map(p => {
    const claim = byMilestone.get(p.count);
    const state = claim ? (claim.status === 'shipped' ? 'shipped' : claim.status === 'rejected' ? 'rejected' : 'requested')
      : counts.counted >= p.count ? 'claimable' : 'locked';
    return { count: p.count, title: p.title, state, claim: claim ? claimView(claim) : null };
  });
  const next = milestones.find(m => m.state === 'locked');
  res.json({
    success: true,
    data: {
      code: s.student_code,
      friends_paid: counts.counted,
      friends_pending: counts.pending,
      friends_joined: counts.joined,
      hold_days: cfg.hold_days,
      milestones,
      next: next ? { count: next.count, title: next.title, remaining: next.count - counts.counted } : null,
    },
  });
});

// POST /api/referrals/me/claim  (student)
exports.claimPrize = asyncHandler(async (req, res) => {
  const s = req.userDoc;
  const milestone = Number(req.body.milestone);
  const cfg = await getConfig();
  const prize = (cfg.prizes || []).find(p => p.count === milestone);
  if (!prize) throw new AppError('This prize is not available', 400);

  const counts = await countFriends(s.student_code);
  if (counts.counted < milestone) throw new AppError(`You need ${milestone} friends who have paid (you have ${counts.counted})`, 400);
  if (await ReferralClaim.findOne({ student_code: s.student_code, milestone }).lean()) throw new AppError('You have already claimed this prize', 409);

  const recipient = String(req.body.recipient_name || '').trim().slice(0, 80);
  const phone = String(req.body.phone || '').trim();
  const address = String(req.body.address || '').trim().slice(0, 300);
  const pincode = String(req.body.pincode || '').trim();
  if (req.body.parent_consent !== true) throw new AppError('A parent or guardian must agree to share the delivery address', 400);
  if (!recipient) throw new AppError('Enter the name of the person who will receive the parcel', 400);
  if (!isValidMobile(phone)) throw new AppError('Enter a valid 10-digit phone number', 400);
  if (address.length < 10) throw new AppError('Enter the full delivery address', 400);
  if (!/^\d{6}$/.test(pincode)) throw new AppError('Enter a 6-digit pincode', 400);

  const claim = await ReferralClaim.create({
    student_user_id: s.user_id, student_code: s.student_code, student_name: s.name,
    milestone, title: prize.title, friends_at_claim: counts.counted,
    recipient_name: recipient, phone, address, pincode, parent_consent: true,
  });
  res.status(201).json({ success: true, data: claimView(claim) });
});

// ── Admin ─────────────────────────────────────────────────────────────────────

exports.listClaims = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status);
  const rows = await ReferralClaim.find(filter).sort({ created_at: -1 }).limit(500).lean();
  res.json({
    success: true,
    data: rows.map(c => ({
      ...claimView(c), student_code: c.student_code, student_name: c.student_name, friends_at_claim: c.friends_at_claim,
      recipient_name: c.recipient_name, phone: c.phone, address: c.address, pincode: c.pincode,
    })),
  });
});

exports.updateClaim = asyncHandler(async (req, res) => {
  const claim = await ReferralClaim.findById(req.params.id);
  if (!claim) throw new AppError('Claim not found', 404);
  const status = String(req.body.status || '').trim();
  if (!['shipped', 'rejected', 'requested'].includes(status)) throw new AppError('status must be shipped, rejected or requested', 400);
  claim.status = status;
  claim.shipped_at = status === 'shipped' ? new Date() : null;
  if (req.body.tracking !== undefined) claim.tracking = String(req.body.tracking || '').trim().slice(0, 100);
  if (req.body.note !== undefined) claim.note = String(req.body.note || '').trim().slice(0, 200);
  await claim.save();
  res.json({ success: true, data: claimView(claim) });
});

exports.countFriends = countFriends;

// GET /api/referrals/summary (admin): every student who has shared the app, with friend counts.
exports.summary = asyncHandler(async (req, res) => {
  const friends = await User.find({ role: 'student', referred_by_student: { $exists: true, $nin: ['', null] } })
    .select('name student_code user_id referred_by_student created_at').lean();
  if (!friends.length) return res.json({ success: true, data: [], prizes: (await getConfig()).prizes });
  const cfg = await getConfig();
  const cutoff = new Date(Date.now() - (cfg.hold_days || 0) * DAY_MS);
  const subs = await StudentSubscription.find({
    student_user_id: { $in: friends.map(f => f.user_id) },
    payment_verified: true, is_trial: false, amount: { $gt: 0 }, status: { $nin: ['cancelled', 'failed'] },
  }).select('student_user_id start_date created_at').lean();
  const firstPaid = new Map();
  for (const s of subs) {
    const at = s.start_date || s.created_at;
    const prev = firstPaid.get(s.student_user_id);
    if (!prev || at < prev) firstPaid.set(s.student_user_id, at);
  }
  const owners = new Map();
  for (const f of friends) {
    const o = owners.get(f.referred_by_student) || { code: f.referred_by_student, joined: 0, paid: 0, pending: 0, friends: [] };
    const at = firstPaid.get(f.user_id);
    const state = !at ? 'not paid' : at <= cutoff ? 'paid' : 'in wait';
    o.joined++;
    if (state === 'paid') o.paid++; else if (state === 'in wait') o.pending++;
    o.friends.push({ name: f.name, code: f.student_code, state, joined_at: f.created_at });
    owners.set(o.code, o);
  }
  const names = new Map((await User.find({ role: 'student', student_code: { $in: [...owners.keys()] } }).select('name student_code').lean()).map(u => [u.student_code, u.name]));
  const claims = await ReferralClaim.find({ student_code: { $in: [...owners.keys()] } }).select('student_code milestone status').lean();
  const rows = [...owners.values()].map(o => ({
    ...o,
    name: names.get(o.code) || '',
    claims: claims.filter(c => c.student_code === o.code).map(c => ({ milestone: c.milestone, status: c.status })),
  })).sort((a, b) => b.paid - a.paid || b.joined - a.joined);
  res.json({ success: true, data: rows, prizes: cfg.prizes });
});
