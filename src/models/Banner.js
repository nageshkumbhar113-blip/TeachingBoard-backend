const { mongoose } = require('../config/db');
const { randomUUID } = require('crypto');

// Student Home screen promo carousel. Purely additive — no existing
// collection/field touched. `scope: 'all'` shows the banner to every
// student regardless of batch; `scope: 'batches'` restricts it to the
// batches listed in `batchNames` (matched case-insensitively, same
// convention as Note/SLS batch-gating elsewhere in this codebase).
const bannerSchema = new mongoose.Schema({
  banner_id:  { type: String, required: true, unique: true, index: true, default: () => randomUUID() },
  imageUrl:   { type: String, default: '', trim: true },   // optional — a text-only banner is valid
  title:      { type: String, required: true, trim: true },
  subtitle:   { type: String, default: '', trim: true },
  linkType:   { type: String, enum: ['none', 'batch', 'subject', 'url'], default: 'none' },
  linkValue:  { type: String, default: '', trim: true },
  scope:      { type: String, enum: ['all', 'batches'], default: 'all' },
  batchNames: { type: [String], default: [] },   // only used when scope === 'batches'
  order:      { type: Number, default: 0 },
  active:     { type: Boolean, default: true },
  openCount:  { type: Number, default: 0 },
  created_by: { type: String, default: '' },
  created_at: { type: Date, default: Date.now },
}, {
  timestamps: false,
  versionKey: false,
});

bannerSchema.index({ active: 1, order: 1 });

module.exports = mongoose.model('Banner', bannerSchema);
