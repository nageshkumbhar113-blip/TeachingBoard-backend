const express = require('express');
const { requireYoutubeTeacher, requireStudent, requireAdmin } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimiter');
const authCtrl    = require('../controllers/youtubeTeacherAuthController');
const ctrl        = require('../controllers/youtubeTeacherController');
const payCtrl      = require('../controllers/youtubeTeacherPaymentController');
const adminCtrl    = require('../controllers/youtubeTeacherAdminController');

const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many attempts — please try again later',
});

// ── Teacher-facing: /api/youtube-teacher ─────────────────────────────────────
const teacherRouter = express.Router();

teacherRouter.post('/register', authLimiter, authCtrl.register);
teacherRouter.post('/login',    authLimiter, authCtrl.login);

teacherRouter.get('/profile',  requireYoutubeTeacher, ctrl.getProfile);
teacherRouter.put('/profile',  requireYoutubeTeacher, ctrl.updateProfile);

teacherRouter.get('/batch-tree', requireYoutubeTeacher, ctrl.getBatchTree);
teacherRouter.get('/exercises',  requireYoutubeTeacher, ctrl.getExercisesForChapter);
teacherRouter.get('/concepts',   requireYoutubeTeacher, ctrl.getConceptsForChapter);
teacherRouter.get('/content-overview', requireYoutubeTeacher, ctrl.getContentOverview);

teacherRouter.get('/teaching-areas',       requireYoutubeTeacher, ctrl.listTeachingAreas);
teacherRouter.post('/teaching-areas',      requireYoutubeTeacher, ctrl.addTeachingArea);
teacherRouter.delete('/teaching-areas/:id', requireYoutubeTeacher, ctrl.removeTeachingArea);

teacherRouter.get('/videos',          requireYoutubeTeacher, ctrl.listMyVideos);
teacherRouter.post('/videos',         requireYoutubeTeacher, ctrl.upsertVideo);
teacherRouter.delete('/videos/:id',   requireYoutubeTeacher, ctrl.deleteVideo);
teacherRouter.get('/missing-videos',  requireYoutubeTeacher, ctrl.listMissingVideos);

teacherRouter.post('/subscription/create',      requireYoutubeTeacher, payCtrl.createSubscriptionOrder);
teacherRouter.post('/subscription/verify',      requireYoutubeTeacher, payCtrl.verifySubscription);
teacherRouter.post('/subscription/start-trial', requireYoutubeTeacher, payCtrl.startTrial);
teacherRouter.get('/subscription',              requireYoutubeTeacher, payCtrl.getMySubscription);
teacherRouter.get('/payment-history',           requireYoutubeTeacher, payCtrl.getPaymentHistory);

// Public — no auth. Read-only prices for the Landing page (shown before
// registration/login exists) and the in-dashboard plan picker.
teacherRouter.get('/plan-config', payCtrl.getPlanConfig);

// video-open is intentionally NOT auth-gated by youtube_teacher OR student —
// it's called by the student app's embedded player, guarded by requireStudent
// below (kept with the other student-facing routes for clarity).

// ── Student-facing: mounted at /api/youtube-teacher too (same base, student auth) ──
teacherRouter.get('/videos-for-exercise', requireStudent, (req, res, next) => {
  // Two-step endpoint on one path: teacher_id present = step 2 (that
  // teacher's parts), absent = step 1 (card list) — see plan Section 15.
  return req.query.teacher_id ? ctrl.videosForExerciseStep2(req, res, next) : ctrl.videosForExerciseStep1(req, res, next);
});
teacherRouter.post('/video-open/:videoId', requireStudent, ctrl.recordVideoOpen);

// ── Admin-facing: /api/admin/youtube-teacher-* ───────────────────────────────
const adminRouter = express.Router();

adminRouter.get('/youtube-teacher-partners',  requireAdmin, adminCtrl.listPartners);
adminRouter.post('/youtube-teacher-partners/:id/suspend',        requireAdmin, adminCtrl.suspendPartner);
adminRouter.post('/youtube-teacher-partners/:id/activate',       requireAdmin, adminCtrl.activatePartner);
adminRouter.post('/youtube-teacher-partners/:id/verify-channel', requireAdmin, adminCtrl.verifyChannel);

adminRouter.get('/youtube-teacher-videos',                requireAdmin, adminCtrl.listVideos);
adminRouter.post('/youtube-teacher-videos/:id/approve',   requireAdmin, adminCtrl.approveVideo);
adminRouter.post('/youtube-teacher-videos/:id/reject',    requireAdmin, adminCtrl.rejectVideo);

adminRouter.get('/youtube-teacher-video-gaps',     requireAdmin, adminCtrl.videoGaps);
adminRouter.get('/youtube-teacher-subscriptions',  requireAdmin, adminCtrl.listSubscriptions);

adminRouter.get('/youtube-teacher-plan-config', requireAdmin, adminCtrl.getPlanConfig);
adminRouter.put('/youtube-teacher-plan-config', requireAdmin, adminCtrl.updatePlanConfig);

module.exports = { teacherRouter, adminRouter };
