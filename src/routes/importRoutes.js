const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const ctrl = require('../controllers/importController');

const router = express.Router();

router.get('/source-chapters', requireAdmin, ctrl.listSourceChapters);
router.post('/preview',        requireAdmin, ctrl.preview);
router.post('/run',            requireAdmin, ctrl.run);
router.get('/jobs',            requireAdmin, ctrl.listJobs);
router.post('/undo',           requireAdmin, ctrl.undo);

module.exports = router;
