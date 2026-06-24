const express      = require('express');
const { requireAdmin, requireStudent } = require('../middleware/auth');
const ctrl = require('../controllers/wordTestController');

// ── Admin router (/api/admin/word-tests) ──────────────────────────
const adminRouter = express.Router();

adminRouter.get('/stats',                       requireAdmin, ctrl.getWordBankStats);
adminRouter.post('/generate',                   requireAdmin, ctrl.generatePreview);
adminRouter.post('/',                           requireAdmin, ctrl.saveDraft);
adminRouter.get('/',                            requireAdmin, ctrl.listTests);
adminRouter.get('/:test_id',                    requireAdmin, ctrl.getTestAdmin);
adminRouter.patch('/:test_id',                  requireAdmin, ctrl.updateTest);
adminRouter.post('/:test_id/publish',           requireAdmin, ctrl.publishTest);
adminRouter.post('/:test_id/unpublish',         requireAdmin, ctrl.unpublishTest);
adminRouter.delete('/:test_id',                 requireAdmin, ctrl.deleteTest);
adminRouter.get('/:test_id/results',            requireAdmin, ctrl.getTestResults);

// ── Student router (/api/word-tests) ─────────────────────────────
const studentRouter = express.Router();

studentRouter.get('/',                          requireStudent, ctrl.listStudentTests);
studentRouter.get('/:test_id',                  requireStudent, ctrl.getTestStudent);
studentRouter.post('/:test_id/attempt',         requireStudent, ctrl.submitAttempt);

module.exports = { adminRouter, studentRouter };
