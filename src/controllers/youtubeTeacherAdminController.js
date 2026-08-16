const YoutubeTeacherPartner       = require('../models/YoutubeTeacherPartner');
const YoutubeTeacherTeachingArea  = require('../models/YoutubeTeacherTeachingArea');
const YoutubeTeacherVideo         = require('../models/YoutubeTeacherVideo');
const YoutubeTeacherSubscription  = require('../models/YoutubeTeacherSubscription');
const Batch       = require('../models/Batch');
const SLSQuestion = require('../models/SLSQuestion');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { serializePartner } = require('./youtubeTeacherAuthController');
const { makeChapterId } = require('./youtubeTeacherController');

// ── Directory ────────────────────────────────────────────────────────────────

// GET /api/admin/youtube-teacher-partners
exports.listPartners = asyncHandler(async (_req, res) => {
  const partners = await YoutubeTeacherPartner.find().sort({ created_at: -1 }).lean();
  res.json({ success: true, data: partners.map(serializePartner) });
});

// POST /api/admin/youtube-teacher-partners/:id/suspend
exports.suspendPartner = asyncHandler(async (req, res) => {
  const partner = await YoutubeTeacherPartner.findByIdAndUpdate(req.params.id, { status: 'suspended' }, { new: true });
  if (!partner) throw new AppError('Partner not found', 404);
  res.json({ success: true, data: serializePartner(partner) });
});

// POST /api/admin/youtube-teacher-partners/:id/activate
exports.activatePartner = asyncHandler(async (req, res) => {
  const partner = await YoutubeTeacherPartner.findByIdAndUpdate(req.params.id, { status: 'active' }, { new: true });
  if (!partner) throw new AppError('Partner not found', 404);
  res.json({ success: true, data: serializePartner(partner) });
});

// POST /api/admin/youtube-teacher-partners/:id/verify-channel
exports.verifyChannel = asyncHandler(async (req, res) => {
  const partner = await YoutubeTeacherPartner.findByIdAndUpdate(
    req.params.id,
    {
      channel_verified: true,
      channel_verified_at: new Date(),
      channel_verified_by: req.user.id,
      ...(req.body.youtube_channel_name ? { youtube_channel_name: String(req.body.youtube_channel_name).trim() } : {}),
    },
    { new: true }
  );
  if (!partner) throw new AppError('Partner not found', 404);
  res.json({ success: true, data: serializePartner(partner) });
});

// ── Video Approvals ───────────────────────────────────────────────────────────

// GET /api/admin/youtube-teacher-videos?status=pending
exports.listVideos = asyncHandler(async (req, res) => {
  const filter = {};
  const status = String(req.query.status || 'pending').trim();
  if (['pending', 'approved', 'rejected'].includes(status)) filter.status = status;

  const videos = await YoutubeTeacherVideo.find(filter).sort({ updated_at: -1 }).limit(200).lean();
  const teacherIds = [...new Set(videos.map(v => String(v.youtube_teacher_id)))];
  const partners = await YoutubeTeacherPartner.find({ _id: { $in: teacherIds } }, 'name email').lean();
  const nameMap = new Map(partners.map(p => [String(p._id), p.name]));

  res.json({
    success: true,
    data: videos.map(v => ({
      id: String(v._id),
      teacher_name: nameMap.get(String(v.youtube_teacher_id)) || '(deleted)',
      content_type: v.content_type || 'exercise',
      batch_name: v.batch_name, subject_name: v.subject_name, chapter_name: v.chapter_name,
      exercise_no: v.exercise_no || '', concept_title: v.concept_title || '',
      part_label: v.part_label || '',
      live_video_id: v.live_video_id || '',
      pending_video_id: v.pending_video_id || '',
      pending_part_label: v.pending_part_label || '',
      status: v.status,
      rejection_reason: v.rejection_reason || '',
      submitted_at: v.pending_submitted_at,
    })),
  });
});

// POST /api/admin/youtube-teacher-videos/:id/approve
// Promotes pending_* → live_* (App-store-update pattern — the previously
// live version, if any, is replaced only now, not at submit time).
exports.approveVideo = asyncHandler(async (req, res) => {
  const video = await YoutubeTeacherVideo.findById(req.params.id);
  if (!video) throw new AppError('Video not found', 404);
  if (!video.pending_video_id) throw new AppError('Nothing pending on this video', 400);

  video.live_video_id = video.pending_video_id;
  video.live_part_label = video.pending_part_label;
  video.pending_video_id = '';
  video.pending_part_label = '';
  video.pending_submitted_at = null;
  video.status = 'approved';
  video.rejection_reason = '';
  video.approved_at = new Date();
  await video.save();

  res.json({ success: true, message: 'Video approved', data: { id: String(video._id), status: video.status } });
});

// POST /api/admin/youtube-teacher-videos/:id/reject  { reason }
exports.rejectVideo = asyncHandler(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw new AppError('reason is required', 400);

  const video = await YoutubeTeacherVideo.findById(req.params.id);
  if (!video) throw new AppError('Video not found', 404);

  video.status = 'rejected';
  video.rejection_reason = reason;
  video.last_rejection_reason = reason;
  video.last_rejected_at = new Date();
  // Pending submission is cleared — teacher must edit and resubmit.
  // The last-approved live_* (if any) is untouched and keeps showing.
  video.pending_video_id = '';
  video.pending_part_label = '';
  await video.save();

  res.json({ success: true, message: 'Video rejected', data: { id: String(video._id), status: video.status } });
});

// ── Video Gaps (platform-wide — distinct from a teacher's own "Missing Videos") ──

// GET /api/admin/youtube-teacher-video-gaps?batch=&subject=
exports.videoGaps = asyncHandler(async (req, res) => {
  const batchName = String(req.query.batch || '').trim();
  const subjectName = String(req.query.subject || '').trim();
  if (!batchName || !subjectName) throw new AppError('batch and subject are required', 400);

  const batch = await Batch.findOne({ name: batchName, 'subjects.name': subjectName }).lean();
  const subjectDoc = batch?.subjects.find(s => s.name === subjectName);
  if (!subjectDoc) return res.json({ success: true, data: [] });

  const covered = new Set(
    (await YoutubeTeacherVideo.find({ batch_name: batchName, subject_name: subjectName, status: 'approved' })
      .select('chapter_name exercise_no').lean())
      .map(v => `${v.chapter_name}::${v.exercise_no}`)
  );

  const gaps = [];
  for (const ch of subjectDoc.chapters || []) {
    const chapterId = makeChapterId(batchName, subjectName, ch.name);
    const exerciseNos = await SLSQuestion.distinct('exerciseNo', { chapterId, status: 'published', exerciseNo: { $ne: '' } });
    for (const exNo of exerciseNos) {
      if (!covered.has(`${ch.name}::${exNo}`)) gaps.push({ chapter_name: ch.name, exercise_no: exNo });
    }
  }
  res.json({ success: true, data: gaps });
});

// ── Subscriptions Overview ────────────────────────────────────────────────────

// GET /api/admin/youtube-teacher-subscriptions
exports.listSubscriptions = asyncHandler(async (_req, res) => {
  const subs = await YoutubeTeacherSubscription.find().sort({ created_at: -1 }).limit(200).lean();
  const teacherIds = [...new Set(subs.map(s => String(s.youtube_teacher_id)))];
  const partners = await YoutubeTeacherPartner.find({ _id: { $in: teacherIds } }, 'name email').lean();
  const nameMap = new Map(partners.map(p => [String(p._id), p.name]));

  res.json({
    success: true,
    data: subs.map(s => ({
      id: String(s._id),
      teacher_name: nameMap.get(String(s.youtube_teacher_id)) || '(deleted)',
      plan_type: s.plan_type, is_premium: s.is_premium,
      amount: s.amount, status: s.status,
      start_date: s.start_date, expiry_date: s.expiry_date,
    })),
  });
});
