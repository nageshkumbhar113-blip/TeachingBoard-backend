const { mongoose } = require('../config/db');
const { randomUUID } = require('crypto');

// Admin-editable text shown on the student Home banner carousel ONLY when
// that student has zero real Banner documents (see bannerController.js's
// getDefaultQuotesForStudent / getBannersForStudent) — fills the "nothing
// to show" gap with something nicer than an empty box. No scope/link/image
// fields on purpose: these are always global, text-only, and never
// clickable — a much smaller shape than Banner itself.
const defaultQuoteSchema = new mongoose.Schema({
  quote_id:   { type: String, required: true, unique: true, index: true, default: () => randomUUID() },
  text:       { type: String, required: true, trim: true },
  order:      { type: Number, default: 0 },
  active:     { type: Boolean, default: true },
  created_by: { type: String, default: '' },
  created_at: { type: Date, default: Date.now },
}, {
  timestamps: false,
  versionKey: false,
});

defaultQuoteSchema.index({ active: 1, order: 1 });

module.exports = mongoose.model('DefaultBannerQuote', defaultQuoteSchema);
