const express = require('express');
const { requireAdmin, requireStudent } = require('../middleware/auth');
const ctrl    = require('../controllers/bannerController');

// ── Admin: /api/admin/banners ───────────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.get('/',       requireAdmin, ctrl.listBannersAdmin);
adminRouter.post('/',      requireAdmin, ctrl.createBanner);
adminRouter.put('/:id',    requireAdmin, ctrl.updateBanner);
adminRouter.delete('/:id', requireAdmin, ctrl.deleteBanner);

// Default Quotes — admin-editable fallback text shown on the student Home
// carousel only when that student has zero real banners (see
// getDefaultQuotesForStudent). Same '/api/admin/banners' base, own
// sub-path — literal '/default-quotes' segment never collides with the
// ':id' routes above (different path shapes).
adminRouter.get('/default-quotes',       requireAdmin, ctrl.listDefaultQuotesAdmin);
adminRouter.post('/default-quotes',      requireAdmin, ctrl.createDefaultQuote);
adminRouter.put('/default-quotes/:id',   requireAdmin, ctrl.updateDefaultQuote);
adminRouter.delete('/default-quotes/:id', requireAdmin, ctrl.deleteDefaultQuote);

// ── Student: /api/banners ───────────────────────────────────────────────────
const studentRouter = express.Router();
studentRouter.get('/for-student',    requireStudent, ctrl.getBannersForStudent);
studentRouter.post('/:id/open',      requireStudent, ctrl.recordBannerOpen);
studentRouter.get('/default-quotes', requireStudent, ctrl.getDefaultQuotesForStudent);

module.exports = { adminRouter, studentRouter };
