const express = require('express');
const { requireAdmin, requireParent } = require('../middleware/auth');
const {
  getParents,
  createParent,
  updateParent,
  deleteParent,
  getMyChildren,
  getChildAttempts,
  updateDeviceToken,
} = require('../controllers/parentController');

// ── Admin CRUD: mounted at /api/parents ───────────────────────────────────────
const adminRouter = express.Router();
adminRouter.get('/',       requireAdmin, getParents);
adminRouter.post('/',      requireAdmin, createParent);
adminRouter.patch('/:id',  requireAdmin, updateParent);
adminRouter.delete('/:id', requireAdmin, deleteParent);

// ── Parent dashboard: mounted at /api/parent ──────────────────────────────────
const parentRouter = express.Router();
parentRouter.get('/children',                requireParent, getMyChildren);
parentRouter.get('/children/:code/attempts', requireParent, getChildAttempts);
parentRouter.patch('/device-token',          requireParent, updateDeviceToken);

module.exports = { adminRouter, parentRouter };
