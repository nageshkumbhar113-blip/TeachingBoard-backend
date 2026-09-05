const express = require('express');
const { requireAdmin, requireStudent } = require('../middleware/auth');
const ctrl    = require('../controllers/bannerController');

// ── Admin: /api/admin/banners ───────────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.get('/',       requireAdmin, ctrl.listBannersAdmin);
adminRouter.post('/',      requireAdmin, ctrl.createBanner);
adminRouter.put('/:id',    requireAdmin, ctrl.updateBanner);
adminRouter.delete('/:id', requireAdmin, ctrl.deleteBanner);

// ── Student: /api/banners ───────────────────────────────────────────────────
const studentRouter = express.Router();
studentRouter.get('/for-student',  requireStudent, ctrl.getBannersForStudent);
studentRouter.post('/:id/open',    requireStudent, ctrl.recordBannerOpen);

module.exports = { adminRouter, studentRouter };
