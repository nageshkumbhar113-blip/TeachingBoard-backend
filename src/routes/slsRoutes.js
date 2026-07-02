const express = require('express');
const { requireAdmin, requireStudent } = require('../middleware/auth');
const {
  createConcept,
  getConcept,
  getChapterConcepts,
  getPublishedChapters,
  updateConcept,
  deleteConcept,
  publishConcept,
  restoreVersion,
  searchConcepts,
  getConceptAnalytics,
  autoTranslateContent
} = require('../controllers/conceptController');
const slsController = require('../controllers/slsController');

// ════════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES: Concept Management
// ════════════════════════════════════════════════════════════════════════════════

const adminRouter = express.Router();

adminRouter.post('/',                      requireAdmin, createConcept);
adminRouter.get('/:conceptId',             requireAdmin, getConcept);
adminRouter.patch('/:conceptId',           requireAdmin, updateConcept);
adminRouter.delete('/:conceptId',          requireAdmin, deleteConcept);
adminRouter.post('/:conceptId/publish',    requireAdmin, publishConcept);
adminRouter.post('/:conceptId/restore',    requireAdmin, restoreVersion);
adminRouter.get('/:conceptId/analytics',   requireAdmin, getConceptAnalytics);
adminRouter.post('/:conceptId/translate',  requireAdmin, autoTranslateContent);

// ════════════════════════════════════════════════════════════════════════════════
// STUDENT ROUTES: Concept Reading
// ════════════════════════════════════════════════════════════════════════════════

const studentRouter = express.Router();

studentRouter.get('/chapters',                     requireStudent, getPublishedChapters);
studentRouter.get('/chapters/:chapterId/concepts', requireStudent, getChapterConcepts);
studentRouter.get('/search',                       requireStudent, searchConcepts);
studentRouter.get('/:conceptId/view',              requireStudent, getConcept);

// ════════════════════════════════════════════════════════════════════════════════
// SLS PHASE 2: Smart Learning System - Questions & Papers
// ════════════════════════════════════════════════════════════════════════════════

const slsRouter = express.Router();

// ───── ADMIN: Question Management
slsRouter.post('/admin/questions',                    requireAdmin, slsController.createQuestion);
slsRouter.get('/admin/questions',                     requireAdmin, slsController.getQuestions);
slsRouter.patch('/admin/questions/:id',               requireAdmin, slsController.updateQuestion);
slsRouter.delete('/admin/questions/:id',              requireAdmin, slsController.deleteQuestion);
slsRouter.post('/admin/questions/:id/publish',        requireAdmin, slsController.publishQuestion);

// ───── ADMIN: Paper Generation & Management
slsRouter.post('/admin/papers/generate',              requireAdmin, slsController.generatePaper);
slsRouter.get('/admin/papers',                        requireAdmin, slsController.getPapers);
slsRouter.get('/admin/papers/:id',                    requireAdmin, slsController.getPaperWithQuestions);
slsRouter.post('/admin/papers/:id/publish',           requireAdmin, slsController.publishPaper);

// ───── ADMIN: Evaluation & Marking
slsRouter.patch('/admin/attempts/:id/evaluate',       requireAdmin, slsController.evaluateAttempt);
slsRouter.get('/admin/attempts',                      requireAdmin, slsController.getStudentAttempts);

// ───── STUDENT: Paper Taking
slsRouter.get('/student/papers',                      requireStudent, slsController.getPapers);
slsRouter.get('/student/papers/:id',                  requireStudent, slsController.getPaperWithQuestions);
slsRouter.post('/student/papers/:paperId/submit',     requireStudent, slsController.submitAnswers);
slsRouter.get('/student/attempts',                    requireStudent, slsController.getStudentAttempts);
slsRouter.get('/student/attempts/:id',                requireStudent, slsController.getAttemptDetails);

// ───── PUBLIC: Published Papers
slsRouter.get('/papers/published',                    slsController.getPapers);

module.exports = { adminRouter, studentRouter, slsRouter };
