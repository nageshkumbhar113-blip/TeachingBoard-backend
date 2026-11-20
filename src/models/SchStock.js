const { mongoose } = require('../config/db');

/**
 * 📚 Scholarship question-generator stock (owner 2026-11-20). The admin pastes word lists, sentences and
 * passages (often made with ChatGPT / Claude outside the app) into Admin › Create Quiz › 🎓 शिष्यवृत्ती ›
 * "📚 साठा वाढवा". The admin panel parses them, drops what is already there, and saves one batch.
 * The generator (admin-app/schLang.js + schStock.js) adds these entries to its built-in banks.
 *
 * SchStockBatch — one paste: name, where it came from, live (used in questions) or review (waits for a check).
 * SchStockItem  — one entry of one kind (e.g. kind 'mrSyn', entry ['पाणी', ['तोय']]); `norm` is the
 *                 duplicate key made by the panel, unique per exam + kind, so the same entry is never saved twice.
 */
const batchSchema = new mongoose.Schema({
  exam:       { type: String, required: true, trim: true, index: true },
  name:       { type: String, default: '', trim: true, maxlength: 120 },
  source:     { type: String, default: '', trim: true, maxlength: 40 },
  status:     { type: String, enum: ['live', 'review'], default: 'live' },
  count:      { type: Number, default: 0 },
  created_by: { type: String, default: '', trim: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const itemSchema = new mongoose.Schema({
  exam:     { type: String, required: true, trim: true },
  kind:     { type: String, required: true, trim: true, maxlength: 40 },
  entry:    { type: mongoose.Schema.Types.Mixed, required: true },
  norm:     { type: String, required: true, maxlength: 600 },
  batch_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });
itemSchema.index({ exam: 1, kind: 1, norm: 1 }, { unique: true });

module.exports = {
  SchStockBatch: mongoose.models.SchStockBatch || mongoose.model('SchStockBatch', batchSchema),
  SchStockItem: mongoose.models.SchStockItem || mongoose.model('SchStockItem', itemSchema),
};
