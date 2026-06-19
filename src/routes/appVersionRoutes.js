const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const {
  getLatestVersion,
  getAllVersions,
  createVersion,
  activateVersion,
  deleteVersion,
} = require('../controllers/appVersionController');

const router = express.Router();

// Public — no auth required (student app polls this on startup)
router.get('/latest',           getLatestVersion);

// Admin only
router.get('/',                 requireAdmin, getAllVersions);
router.post('/',                requireAdmin, createVersion);
router.patch('/:id/activate',   requireAdmin, activateVersion);
router.delete('/:id',           requireAdmin, deleteVersion);

module.exports = router;
