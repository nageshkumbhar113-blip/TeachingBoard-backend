const express = require('express');
const { requireStudent, requireTeacher } = require('../middleware/auth');
const c = require('../controllers/studyPlanController');

const router = express.Router();

router.post('/',               requireStudent, c.createPlan);
router.get('/me',              requireStudent, c.getMyPlan);
router.get('/me/today',        requireStudent, c.getMyToday);
router.patch('/me/tasks/:id',  requireStudent, c.updateTask);
router.delete('/me',           requireStudent, c.abandonPlan);

router.get('/teacher/summary', requireTeacher, c.getTeacherSummary);

module.exports = router;
