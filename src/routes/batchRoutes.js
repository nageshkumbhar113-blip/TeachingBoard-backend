const express = require('express');
const router  = express.Router();
const { requireAdmin, requireTeacherOrAdmin, requireStudent } = require('../middleware/auth');
const {
  getBatches,
  getStudentBatchHierarchy,
  createBatch,
  deleteBatch,
  renameBatch,
  addSubject,
  renameSubject,
  deleteSubject,
  addChapter,
  renameChapter,
  deleteChapter,
  reorderChapters,
  getSubjectChapters,
  updateBatchPricing,
  getBatchPricing,
  getAllBatchesPricing,
  repairBatchChapterIds,
  listOrphanedChapterIds,
} = require('../controllers/batchController');

// Read-only, no pricing/sensitive fields — safe for teachers to browse
// batch/subject/chapter names for Paper Builder.
router.get('/',                                                        requireTeacherOrAdmin, getBatches);
// Student-safe equivalent of the above — own assigned batches only, no
// pricing. See getStudentBatchHierarchy's own doc-comment for the bug this fixes.
router.get('/student/hierarchy',                                       requireStudent, getStudentBatchHierarchy);
router.get('/orphaned-chapter-ids',                                    requireAdmin, listOrphanedChapterIds);
router.get('/pricing/all',                                             getAllBatchesPricing);
router.post('/',                                                       requireAdmin, createBatch);
router.put('/:name',                                                   requireAdmin, renameBatch);
router.delete('/:name',                                                requireAdmin, deleteBatch);
// One-time repair for batches renamed before the chapterId-cascade fix in
// renameBatch existed — see repairBatchChapterIds's own doc-comment.
router.post('/:name/repair-chapter-ids',                               requireAdmin, repairBatchChapterIds);
router.get('/:name/pricing',                                           getBatchPricing);
router.put('/:name/pricing',                                           requireAdmin, updateBatchPricing);
router.post('/:name/subjects',                                         requireAdmin, addSubject);
router.put('/:name/subjects/:subject',                                 requireAdmin, renameSubject);
router.delete('/:name/subjects/:subject',                              requireAdmin, deleteSubject);
router.get('/:name/subjects/:subject/chapters',                        getSubjectChapters);
router.post('/:name/subjects/:subject/chapters',                       requireAdmin, addChapter);
// Literal 'reorder' segment MUST be registered before the :chapter wildcard
// PUT route below, or a request to .../chapters/reorder would incorrectly
// match renameChapter with :chapter="reorder" (Express matches routes in
// registration order, not literal-before-param).
router.put('/:name/subjects/:subject/chapters/reorder',                requireAdmin, reorderChapters);
router.put('/:name/subjects/:subject/chapters/:chapter',               requireAdmin, renameChapter);
router.delete('/:name/subjects/:subject/chapters/:chapter',            requireAdmin, deleteChapter);

module.exports = router;
