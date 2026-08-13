const YoutubeTeacherPartner       = require('../models/YoutubeTeacherPartner');
const YoutubeTeacherTeachingArea  = require('../models/YoutubeTeacherTeachingArea');
const YoutubeTeacherVideo         = require('../models/YoutubeTeacherVideo');
const YoutubeTeacherSubscription  = require('../models/YoutubeTeacherSubscription');
const Batch      = require('../models/Batch');
const SLSQuestion = require('../models/SLSQuestion');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { serializePartner } = require('./youtubeTeacherAuthController');

// ── Helpers ──────────────────────────────────────────────────────────────────

// Same composite scheme as exerciseViewer.js's _makeChapterId() /
// slsController.getStudentExerciseQuestions — must stay byte-identical or
// exercise lookups silently return nothing.
function makeChapterId(batch, subject, chapter) {
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
  return `${norm(batch)}::${norm(subject)}::${norm(chapter)}`;
}

function normalizePartKey(label) {
  const s = String(label || '').trim().toLowerCase().replace(/\s+/g, '-');
  return s || 'default';
}

// Accepts youtu.be/, youtube.com/watch?v=, youtube.com/embed/, youtube-nocookie.com/embed/
function extractVideoId(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  let m = s.match(/^https?:\/\/(?:www\.)?youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = s.match(/^https?:\/\/(?:www\.)?(?:youtube|youtube-nocookie)\.com\/watch\?[^#]*\bv=([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = s.match(/^https?:\/\/(?:www\.)?(?:youtube|youtube-nocookie)\.com\/embed\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  // Bare 11-char video ID, already extracted client-side
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return '';
}

function serializeVideo(v) {
  return {
    id: String(v._id),
    batch_name: v.batch_name,
    subject_name: v.subject_name,
    chapter_name: v.chapter_name,
    exercise_no: v.exercise_no,
    part_label: v.part_label || '',
    live_video_id: v.live_video_id || '',
    live_part_label: v.live_part_label || '',
    pending_video_id: v.pending_video_id || '',
    pending_part_label: v.pending_part_label || '',
    status: v.status,
    rejection_reason: v.rejection_reason || '',
    last_rejection_reason: v.last_rejection_reason || '',
    open_count: v.open_count || 0,
    created_at: v.created_at,
    updated_at: v.updated_at,
  };
}

// ── Profile ──────────────────────────────────────────────────────────────────

// GET /api/youtube-teacher/profile
exports.getProfile = asyncHandler(async (req, res) => {
  const partner = await YoutubeTeacherPartner.findById(req.user.id);
  if (!partner) throw new AppError('Account not found', 404);
  res.json({ success: true, data: serializePartner(partner) });
});

// PUT /api/youtube-teacher/profile
exports.updateProfile = asyncHandler(async (req, res) => {
  const partner = await YoutubeTeacherPartner.findById(req.user.id);
  if (!partner) throw new AppError('Account not found', 404);

  const fields = ['name', 'bio', 'teaching_subject', 'profile_photo', 'intro_video_id'];
  fields.forEach(f => {
    if (req.body[f] !== undefined) partner[f] = String(req.body[f]).trim();
  });

  // Changing the channel URL re-triggers verification (admin must re-check).
  if (req.body.youtube_channel_url !== undefined) {
    const newUrl = String(req.body.youtube_channel_url).trim();
    if (newUrl !== partner.youtube_channel_url) {
      partner.youtube_channel_url = newUrl;
      partner.channel_verified = false;
      partner.channel_verified_at = null;
      partner.channel_verified_by = '';
    }
  }

  if (req.body.new_password) {
    const pw = String(req.body.new_password);
    if (pw.length < 6) throw new AppError('password must be at least 6 characters', 400);
    partner.password_hash = YoutubeTeacherPartner.hashPassword(pw);
  }

  await partner.save();
  res.json({ success: true, data: serializePartner(partner) });
});

// ── Batch / Subject / Chapter / Exercise lookup ──────────────────────────────
// Thin, read-only re-exposure of Batch data for the teacher's Add-Video
// wizard — deliberately NOT reusing /api/batches (requireTeacherOrAdmin,
// a different role) so that middleware's meaning stays untouched.

// GET /api/youtube-teacher/batch-tree
exports.getBatchTree = asyncHandler(async (_req, res) => {
  const batches = await Batch.find({ is_active: true }, 'name subjects.name subjects.chapters.name subjects.chapters.order').lean();
  const data = batches.map(b => ({
    name: b.name,
    subjects: (b.subjects || []).map(s => ({
      name: s.name,
      chapters: (s.chapters || [])
        .slice()
        .sort((a, c) => (a.order || 0) - (c.order || 0))
        .map(c => c.name),
    })),
  }));
  res.json({ success: true, data });
});

// GET /api/youtube-teacher/exercises?batch=&subject=&chapter=
exports.getExercisesForChapter = asyncHandler(async (req, res) => {
  const batch = String(req.query.batch || '').trim();
  const subject = String(req.query.subject || '').trim();
  const chapter = String(req.query.chapter || '').trim();
  if (!batch || !subject || !chapter) throw new AppError('batch, subject and chapter are required', 400);

  const chapterId = makeChapterId(batch, subject, chapter);
  const exerciseNos = await SLSQuestion.distinct('exerciseNo', { chapterId, status: 'published', exerciseNo: { $ne: '' } });
  res.json({ success: true, data: exerciseNos.sort() });
});

// ── Teaching Areas ────────────────────────────────────────────────────────────

// GET /api/youtube-teacher/teaching-areas
exports.listTeachingAreas = asyncHandler(async (req, res) => {
  const areas = await YoutubeTeacherTeachingArea.find({ youtube_teacher_id: req.user.id }).lean();
  res.json({ success: true, data: areas.map(a => ({ id: String(a._id), batch_name: a.batch_name, subject_name: a.subject_name })) });
});

// POST /api/youtube-teacher/teaching-areas  { batch_name, subject_name }
exports.addTeachingArea = asyncHandler(async (req, res) => {
  const batchName = String(req.body.batch_name || '').trim();
  const subjectName = String(req.body.subject_name || '').trim();
  if (!batchName || !subjectName) throw new AppError('batch_name and subject_name are required', 400);

  const area = await YoutubeTeacherTeachingArea.findOneAndUpdate(
    { youtube_teacher_id: req.user.id, batch_name: batchName, subject_name: subjectName },
    { $setOnInsert: { youtube_teacher_id: req.user.id, batch_name: batchName, subject_name: subjectName } },
    { upsert: true, new: true }
  );
  res.status(201).json({ success: true, data: { id: String(area._id), batch_name: area.batch_name, subject_name: area.subject_name } });
});

// DELETE /api/youtube-teacher/teaching-areas/:id
// Removing a Teaching Area PERMANENTLY deletes every video under that
// batch+subject for this teacher (plan Section 7 — explicit, irreversible,
// confirmed client-side before this call is made).
exports.removeTeachingArea = asyncHandler(async (req, res) => {
  const area = await YoutubeTeacherTeachingArea.findOne({ _id: req.params.id, youtube_teacher_id: req.user.id });
  if (!area) throw new AppError('Teaching area not found', 404);

  const deleted = await YoutubeTeacherVideo.deleteMany({
    youtube_teacher_id: req.user.id,
    batch_name: area.batch_name,
    subject_name: area.subject_name,
  });
  await area.deleteOne();

  res.json({ success: true, message: 'Teaching area removed', videos_deleted: deleted.deletedCount || 0 });
});

// ── Videos ────────────────────────────────────────────────────────────────────

// GET /api/youtube-teacher/videos?status=
exports.listMyVideos = asyncHandler(async (req, res) => {
  const filter = { youtube_teacher_id: req.user.id };
  const status = String(req.query.status || '').trim();
  if (['pending', 'approved', 'rejected'].includes(status)) filter.status = status;

  const videos = await YoutubeTeacherVideo.find(filter).sort({ updated_at: -1 }).lean();
  res.json({ success: true, data: videos.map(serializeVideo) });
});

// POST /api/youtube-teacher/videos
// { batch_name, subject_name, chapter_name, exercise_no, youtube_url, part_label }
// Creates a new video (new part), or if a video already exists for this
// exact teacher+exercise+part, submits an edit to pending_* instead of
// creating a duplicate (see model's unique index).
exports.upsertVideo = asyncHandler(async (req, res) => {
  const batchName   = String(req.body.batch_name || '').trim();
  const subjectName = String(req.body.subject_name || '').trim();
  const chapterName = String(req.body.chapter_name || '').trim();
  const exerciseNo  = String(req.body.exercise_no || '').trim();
  const partLabel   = String(req.body.part_label || '').trim();
  const youtubeUrl  = String(req.body.youtube_url || '').trim();

  if (!batchName || !subjectName || !chapterName || !exerciseNo) {
    throw new AppError('batch_name, subject_name, chapter_name and exercise_no are required', 400);
  }
  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) throw new AppError('Could not read a valid YouTube video ID from that URL', 400);

  const partKey = normalizePartKey(partLabel);

  let video = await YoutubeTeacherVideo.findOne({
    youtube_teacher_id: req.user.id,
    batch_name: batchName, subject_name: subjectName, chapter_name: chapterName, exercise_no: exerciseNo,
    part_key: partKey,
  });

  if (video) {
    // Existing video/part → this is an edit. The currently-live version
    // keeps showing to students until admin approves the new one.
    video.pending_video_id = videoId;
    video.pending_part_label = partLabel;
    video.pending_submitted_at = new Date();
    video.status = 'pending';
    await video.save();
    return res.json({ success: true, message: 'Edit submitted for approval', data: serializeVideo(video) });
  }

  video = await YoutubeTeacherVideo.create({
    youtube_teacher_id: req.user.id,
    batch_name: batchName, subject_name: subjectName, chapter_name: chapterName, exercise_no: exerciseNo,
    part_key: partKey, part_label: partLabel,
    pending_video_id: videoId,
    pending_part_label: partLabel,
    pending_submitted_at: new Date(),
    status: 'pending',
  });
  res.status(201).json({ success: true, message: 'Submitted for approval', data: serializeVideo(video) });
});

// DELETE /api/youtube-teacher/videos/:id
exports.deleteVideo = asyncHandler(async (req, res) => {
  const video = await YoutubeTeacherVideo.findOne({ _id: req.params.id, youtube_teacher_id: req.user.id });
  if (!video) throw new AppError('Video not found', 404);
  await video.deleteOne();
  res.json({ success: true, message: 'Video deleted' });
});

// GET /api/youtube-teacher/missing-videos
// Exercises inside MY Teaching Areas where I don't yet have a video —
// regardless of whether other teachers already cover it (per-teacher gap,
// not a global gap — see plan Section 7 "⏳ Missing Videos").
exports.listMissingVideos = asyncHandler(async (req, res) => {
  const areas = await YoutubeTeacherTeachingArea.find({ youtube_teacher_id: req.user.id }).lean();
  if (!areas.length) return res.json({ success: true, data: [] });

  const myVideos = await YoutubeTeacherVideo.find({ youtube_teacher_id: req.user.id })
    .select('batch_name subject_name chapter_name exercise_no').lean();
  const covered = new Set(myVideos.map(v => `${v.batch_name}::${v.subject_name}::${v.chapter_name}::${v.exercise_no}`));

  const gaps = [];
  for (const area of areas) {
    const batch = await Batch.findOne({ name: area.batch_name, 'subjects.name': area.subject_name }).lean();
    const subjectDoc = batch?.subjects.find(s => s.name === area.subject_name);
    for (const ch of (subjectDoc?.chapters || [])) {
      const chapterId = makeChapterId(area.batch_name, area.subject_name, ch.name);
      const exerciseNos = await SLSQuestion.distinct('exerciseNo', { chapterId, status: 'published', exerciseNo: { $ne: '' } });
      for (const exNo of exerciseNos) {
        const key = `${area.batch_name}::${area.subject_name}::${ch.name}::${exNo}`;
        if (!covered.has(key)) {
          gaps.push({ batch_name: area.batch_name, subject_name: area.subject_name, chapter_name: ch.name, exercise_no: exNo });
        }
      }
    }
  }
  res.json({ success: true, data: gaps });
});

// ── Student-facing (requireStudent) ──────────────────────────────────────────

// GET /api/youtube-teacher/videos-for-exercise?batch=&subject=&chapter=&exercise=
// Step 1 — teacher cards only (no exercise video id yet, see plan Section 15).
// Max 5: Premium (eligible = active+approved+≥1 live video) sorted by
// open_count, then non-Premium sorted by open_count.
exports.videosForExerciseStep1 = asyncHandler(async (req, res) => {
  const batch = String(req.query.batch || '').trim();
  const subject = String(req.query.subject || '').trim();
  const chapter = String(req.query.chapter || '').trim();
  const exercise = String(req.query.exercise || '').trim();
  if (!batch || !subject || !chapter || !exercise) {
    throw new AppError('batch, subject, chapter and exercise are required', 400);
  }

  const videos = await YoutubeTeacherVideo.find({
    batch_name: batch, subject_name: subject, chapter_name: chapter, exercise_no: exercise,
    status: 'approved', live_video_id: { $ne: '' },
  }).lean();
  if (!videos.length) return res.json({ success: true, data: [] });

  const teacherIds = [...new Set(videos.map(v => String(v.youtube_teacher_id)))];
  const now = new Date();
  const [partners, subs] = await Promise.all([
    YoutubeTeacherPartner.find({ _id: { $in: teacherIds }, status: 'active' }).lean(),
    YoutubeTeacherSubscription.find({ youtube_teacher_id: { $in: teacherIds }, status: 'active', expiry_date: { $gt: now } }).lean(),
  ]);
  const partnerMap = new Map(partners.map(p => [String(p._id), p]));
  const premiumTeacherIds = new Set(subs.filter(s => s.is_premium).map(s => String(s.youtube_teacher_id)));
  const activeSubTeacherIds = new Set(subs.map(s => String(s.youtube_teacher_id)));

  const videoCountByTeacher = new Map();
  const openCountByTeacher = new Map();
  videos.forEach(v => {
    const tid = String(v.youtube_teacher_id);
    videoCountByTeacher.set(tid, (videoCountByTeacher.get(tid) || 0) + 1);
    openCountByTeacher.set(tid, (openCountByTeacher.get(tid) || 0) + (v.open_count || 0));
  });

  let cards = teacherIds
    .filter(tid => partnerMap.has(tid) && activeSubTeacherIds.has(tid)) // isTeacherLive check
    .map(tid => {
      const p = partnerMap.get(tid);
      return {
        teacher_id: tid,
        name: p.name,
        profile_photo: p.profile_photo || '',
        teaching_subject: p.teaching_subject || '',
        intro_video_id: p.intro_video_id || '',
        video_count: videoCountByTeacher.get(tid) || 0,
        open_count: openCountByTeacher.get(tid) || 0,
        is_premium: premiumTeacherIds.has(tid),
      };
    });

  cards.sort((a, b) => {
    if (a.is_premium !== b.is_premium) return a.is_premium ? -1 : 1;
    return b.open_count - a.open_count;
  });
  cards = cards.slice(0, 5);

  res.json({ success: true, data: cards });
});

// GET /api/youtube-teacher/videos-for-exercise?...&teacher_id=
// Step 2 — the chosen teacher's parts for this exercise.
exports.videosForExerciseStep2 = asyncHandler(async (req, res) => {
  const { batch, subject, chapter, exercise, teacher_id: teacherId } = req.query;
  if (!batch || !subject || !chapter || !exercise || !teacherId) {
    throw new AppError('batch, subject, chapter, exercise and teacher_id are required', 400);
  }

  const videos = await YoutubeTeacherVideo.find({
    youtube_teacher_id: teacherId,
    batch_name: batch, subject_name: subject, chapter_name: chapter, exercise_no: exercise,
    status: 'approved', live_video_id: { $ne: '' },
  }).sort({ created_at: 1 }).lean();

  res.json({
    success: true,
    data: videos.map(v => ({ id: String(v._id), part_label: v.live_part_label || '', video_id: v.live_video_id })),
  });
});

// POST /api/youtube-teacher/video-open/:videoId — public counter increment,
// called by the student app when a video actually starts playing.
exports.recordVideoOpen = asyncHandler(async (req, res) => {
  await YoutubeTeacherVideo.updateOne({ _id: req.params.videoId, status: 'approved' }, { $inc: { open_count: 1 } });
  res.json({ success: true });
});

module.exports.makeChapterId = makeChapterId;
module.exports.extractVideoId = extractVideoId;
