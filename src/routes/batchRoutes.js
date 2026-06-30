const express = require('express');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  getBatches,
  createBatch,
  deleteBatch,
  renameBatch,
  addSubject,
  deleteSubject,
  addChapter,
  deleteChapter,
  updateBatchPricing,
  getBatchPricing,
  getAllBatchesPricing,
} = require('../controllers/batchController');

router.get('/',                                                        requireAdmin, getBatches);
router.get('/pricing/all',                                             getAllBatchesPricing);
router.post('/',                                                       requireAdmin, createBatch);
router.put('/:name',                                                   requireAdmin, renameBatch);
router.delete('/:name',                                                requireAdmin, deleteBatch);
router.get('/:name/pricing',                                           getBatchPricing);
router.put('/:name/pricing',                                           requireAdmin, updateBatchPricing);
router.post('/:name/subjects',                                         requireAdmin, addSubject);
router.delete('/:name/subjects/:subject',                              requireAdmin, deleteSubject);
router.post('/:name/subjects/:subject/chapters',                       requireAdmin, addChapter);
router.delete('/:name/subjects/:subject/chapters/:chapter',            requireAdmin, deleteChapter);

module.exports = router;
