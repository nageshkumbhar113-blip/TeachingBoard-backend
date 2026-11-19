// 🎬 /api/teacher-videos — a school teacher's own YouTube videos for their own students (see teacherVideoController)
const express = require('express');
const { requireTeacher, requireStudent, requireAdmin } = require('../middleware/auth');
const ctrl = require('../controllers/teacherVideoController');
const yt = require('../controllers/youtubeTeacherController');   // read-only pickers (batch tree, exercises, notes, tests)

const router = express.Router();

// teacher
router.get('/mine',         requireTeacher, ctrl.listMine);
router.post('/mine',        requireTeacher, ctrl.create);
router.put('/mine/:id',     requireTeacher, ctrl.update);
router.delete('/mine/:id',  requireTeacher, ctrl.remove);
router.get('/pick/tree',       requireTeacher, yt.getBatchTree);
router.get('/pick/exercises',  requireTeacher, yt.getExercisesForChapter);
router.get('/pick/concepts',   requireTeacher, yt.getConceptsForChapter);
router.get('/pick/quiz-tests', requireTeacher, yt.getQuizTestsForChapter);

// student
router.get('/for-me',     requireStudent, ctrl.forMe);
router.post('/open/:id',  requireStudent, ctrl.open);

// admin
router.get('/admin',              requireAdmin, ctrl.adminList);
router.post('/admin/:id/remove',  requireAdmin, ctrl.adminRemove);

module.exports = router;
