const express = require('express');
const { requireAdmin, requireTeacherOrAdmin, requireStudent } = require('../middleware/auth');
const c = require('../controllers/passageBlockController');

const router = express.Router();

// Student: Exercise screen practice
router.get('/student', requireStudent, c.getStudentBlocks);

// Admin + Teacher (Paper Builder needs read access, same as SLSQuestion's admin/questions GET)
router.get('/', requireTeacherOrAdmin, c.listBlocks);
router.get('/:id', requireTeacherOrAdmin, c.getBlock);

// Admin only: write
router.post('/', requireAdmin, c.createBlock);
router.patch('/:id', requireAdmin, c.updateBlock);
router.delete('/:id', requireAdmin, c.deleteBlock);
router.post('/import/preview', requireAdmin, c.previewImport);
router.post('/import/run', requireAdmin, c.runImport);
router.delete('/import/:jobId', requireAdmin, c.undoImport);

module.exports = router;
