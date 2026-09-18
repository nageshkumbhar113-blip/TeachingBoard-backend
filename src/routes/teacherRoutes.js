const express = require('express');
const { requireAdmin, requireTeacher } = require('../middleware/auth');
const {
  getTeachers,
  createTeacher,
  updateTeacher,
  deleteTeacher,
  getUnassignedStudents,
  getMyStudents,
  getStudentAttempts,
  updateDeviceToken,
  getWeeklyAnalytics,
  getMonthlyAnalytics,
  getWeakTopics,
  getStrongTopics,
  getRanking,
} = require('../controllers/teacherController');
const {
  sendNotification,
  getNotificationHistory,
} = require('../controllers/notificationController');
const { getTeacherVocabScores } = require('../controllers/wordController');
const {
  getMyPaperQuota,
  getQuotaConfig,
  setQuotaConfig,
  listQuotas,
  setOverride,
} = require('../controllers/paperQuotaController');

// ── Admin CRUD: mounted at /api/teachers ──────────────────────────────────────
const adminRouter = express.Router();
adminRouter.get('/',                     requireAdmin, getTeachers);
adminRouter.get('/unassigned-students',  requireAdmin, getUnassignedStudents);
adminRouter.get('/paper-quota',          requireAdmin, listQuotas);
adminRouter.get('/paper-quota/config',   requireAdmin, getQuotaConfig);
adminRouter.put('/paper-quota/config',   requireAdmin, setQuotaConfig);
adminRouter.put('/:id/paper-quota-override', requireAdmin, setOverride);
adminRouter.post('/',                    requireAdmin, createTeacher);
adminRouter.patch('/:id',                requireAdmin, updateTeacher);
adminRouter.delete('/:id',               requireAdmin, deleteTeacher);

// ── Teacher dashboard: mounted at /api/teacher ───────────────────────────────
const teacherRouter = express.Router();
teacherRouter.get('/students',                    requireTeacher, getMyStudents);
teacherRouter.get('/paper-quota',                requireTeacher, getMyPaperQuota);
teacherRouter.get('/students/:code/attempts',     requireTeacher, getStudentAttempts);
teacherRouter.patch('/device-token',              requireTeacher, updateDeviceToken);
teacherRouter.get('/analytics/weekly',            requireTeacher, getWeeklyAnalytics);
teacherRouter.get('/analytics/monthly',           requireTeacher, getMonthlyAnalytics);
teacherRouter.get('/analytics/weak-topics',       requireTeacher, getWeakTopics);
teacherRouter.get('/analytics/strong-topics',     requireTeacher, getStrongTopics);
teacherRouter.get('/analytics/ranking',           requireTeacher, getRanking);
teacherRouter.post('/send-notification',          requireTeacher, sendNotification);
teacherRouter.get('/notification-history',        requireTeacher, getNotificationHistory);
teacherRouter.get('/vocab-scores',                requireTeacher, getTeacherVocabScores);

module.exports = { adminRouter, teacherRouter };
