const express = require('express');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  getBatches,
  createBatch,
  deleteBatch,
  addSubject,
  deleteSubject,
  addChapter,
  deleteChapter,
} = require('../controllers/batchController');

router.get('/',                                                        requireAdmin, getBatches);
router.post('/',                                                       requireAdmin, createBatch);
router.delete('/:name',                                                requireAdmin, deleteBatch);
router.post('/:name/subjects',                                         requireAdmin, addSubject);
router.delete('/:name/subjects/:subject',                              requireAdmin, deleteSubject);
router.post('/:name/subjects/:subject/chapters',                       requireAdmin, addChapter);
router.delete('/:name/subjects/:subject/chapters/:chapter',            requireAdmin, deleteChapter);

module.exports = router;
