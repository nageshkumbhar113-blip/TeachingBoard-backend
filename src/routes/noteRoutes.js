const express         = require('express');
const { requireAdmin, requireStudent } = require('../middleware/auth');
const ctrl            = require('../controllers/noteController');

// ── Admin: /api/admin/notes ───────────────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.post('/upload',  requireAdmin, ctrl.uploadNote);
adminRouter.get('/',         requireAdmin, ctrl.listNotesAdmin);
adminRouter.put('/:id',      requireAdmin, ctrl.updateNote);
adminRouter.delete('/:id',   requireAdmin, ctrl.deleteNote);

// ── Student: /api/notes ───────────────────────────────────────────────────────
const studentRouter = express.Router();
studentRouter.get('/',          requireStudent, ctrl.listNotesStudent);
studentRouter.get('/:id/view',  requireStudent, ctrl.viewNoteStudent);

module.exports = { adminRouter, studentRouter };
