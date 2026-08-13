const YoutubeTeacherPartner = require('../models/YoutubeTeacherPartner');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { createToken } = require('../utils/token');

function serializePartner(p) {
  return {
    id: String(p._id),
    name: p.name,
    mobile: p.mobile,
    email: p.email,
    profile_photo: p.profile_photo || '',
    bio: p.bio || '',
    teaching_subject: p.teaching_subject || '',
    youtube_channel_url: p.youtube_channel_url || '',
    channel_verified: !!p.channel_verified,
    intro_video_id: p.intro_video_id || '',
    status: p.status,
  };
}

// POST /api/youtube-teacher/register
// Step 1 of registration — creates the account immediately (status: 'active'
// account-level, no admin approval needed — only individual videos need
// approval). Plan/payment is a separate follow-up step (subscription create).
exports.register = asyncHandler(async (req, res) => {
  const name   = String(req.body.name || '').trim();
  const mobile = String(req.body.mobile || '').trim();
  const email  = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const teachingSubject = String(req.body.teaching_subject || '').trim();
  const youtubeChannelUrl = String(req.body.youtube_channel_url || '').trim();
  const bio = String(req.body.bio || '').trim();
  const termsAccepted = !!req.body.terms_accepted;

  if (!name) throw new AppError('name is required', 400);
  if (!/^\d{10}$/.test(mobile)) throw new AppError('a valid 10-digit mobile number is required', 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('a valid email is required', 400);
  if (password.length < 6) throw new AppError('password must be at least 6 characters', 400);
  if (!termsAccepted) throw new AppError('you must accept the Terms & Conditions', 400);

  const existing = await YoutubeTeacherPartner.findOne({ $or: [{ mobile }, { email }] });
  if (existing) throw new AppError('An account with this mobile or email already exists', 409);

  const partner = await YoutubeTeacherPartner.create({
    name,
    mobile,
    email,
    password_hash: YoutubeTeacherPartner.hashPassword(password),
    teaching_subject: teachingSubject,
    youtube_channel_url: youtubeChannelUrl,
    bio,
    status: 'active',
    terms_accepted_at: new Date(),
  });

  res.status(201).json({
    success: true,
    message: 'Registered successfully',
    token: createToken({ id: String(partner._id), name: partner.name, role: 'youtube_teacher' }),
    partner: serializePartner(partner),
  });
});

// POST /api/youtube-teacher/login
exports.login = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) throw new AppError('email and password are required', 400);

  const partner = await YoutubeTeacherPartner.findOne({ email });
  if (!partner || !partner.verifyPassword(password)) {
    throw new AppError('Invalid email or password', 401);
  }
  if (partner.status !== 'active') {
    throw new AppError('This account is suspended. Contact support.', 403);
  }

  res.json({
    success: true,
    message: 'Login successful',
    token: createToken({ id: String(partner._id), name: partner.name, role: 'youtube_teacher' }),
    partner: serializePartner(partner),
  });
});

exports.serializePartner = serializePartner;
