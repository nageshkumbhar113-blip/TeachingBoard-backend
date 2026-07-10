const express = require('express');
const { requireAdmin, requireStudent, requireTeacherOrAdmin } = require('../middleware/auth');
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
adminRouter.get('/chapters/:chapterId/concepts', requireAdmin, getChapterConcepts);
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

// ───── ADMIN: Question Management (create/edit/delete/publish stay admin-only;
// GET is requireTeacherOrAdmin — teachers need read access to browse/search
// the bank while building a paper, but cannot mutate questions)
slsRouter.post('/admin/questions',                    requireAdmin, slsController.createQuestion);
slsRouter.get('/admin/questions',                     requireTeacherOrAdmin, slsController.getQuestions);
slsRouter.patch('/admin/questions/:id',               requireAdmin, slsController.updateQuestion);
slsRouter.delete('/admin/questions/:id',              requireAdmin, slsController.deleteQuestion);
slsRouter.post('/admin/questions/:id/publish',        requireAdmin, slsController.publishQuestion);

// ───── ADMIN + TEACHER: Paper Generation & Management (teachers may only
// build/view/publish papers from the existing question bank, per explicit
// scope request — question CRUD above stays admin-only)
slsRouter.post('/admin/papers/generate',              requireTeacherOrAdmin, slsController.generatePaper);
slsRouter.post('/admin/papers',                       requireTeacherOrAdmin, slsController.createPaperManual);
slsRouter.get('/admin/papers',                        requireTeacherOrAdmin, slsController.getPapers);
slsRouter.get('/admin/papers/:id',                    requireTeacherOrAdmin, slsController.getPaperWithQuestions);
slsRouter.post('/admin/papers/:id/publish',           requireTeacherOrAdmin, slsController.publishPaper);

// ───── ADMIN: Evaluation & Marking
slsRouter.patch('/admin/attempts/:id/evaluate',       requireAdmin, slsController.evaluateAttempt);
slsRouter.get('/admin/attempts',                      requireAdmin, slsController.getStudentAttempts);

// ───── STUDENT: Paper Taking
slsRouter.get('/student/papers',                      requireStudent, slsController.getPapers);
slsRouter.get('/student/papers/:id',                  requireStudent, slsController.getPaperWithQuestions);
slsRouter.post('/student/papers/:paperId/submit',     requireStudent, slsController.submitAnswers);
slsRouter.get('/student/attempts',                    requireStudent, slsController.getStudentAttempts);
slsRouter.get('/student/attempts/:id',                requireStudent, slsController.getAttemptDetails);

// Was fully unauthenticated (no client in this codebase actually calls it —
// checked) letting anyone enumerate every batch's published papers with no
// login at all. Locked to the same auth as the equivalent /student/papers.
slsRouter.get('/papers/published',                    requireStudent, slsController.getPapers);

module.exports = { adminRouter, studentRouter, slsRouter };
