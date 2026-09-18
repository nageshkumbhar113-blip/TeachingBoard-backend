const { mongoose } = require('../config/db');

// Single global document (key 'default'): how many papers a teacher may save
// per batch for free, and how many of that batch's students must have paid to
// unlock unlimited papers. `effective_from` is when the rule started — papers
// saved before it are not counted, so teachers with existing papers are not
// suddenly over the limit.
const paperQuotaConfigSchema = new mongoose.Schema(
  {
    key:                  { type: String, default: 'default', unique: true },
    free_papers:          { type: Number, default: 4, min: 0 },
    unlock_paid_students: { type: Number, default: 10, min: 1 },
    effective_from:       { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

module.exports = mongoose.models.PaperQuotaConfig || mongoose.model('PaperQuotaConfig', paperQuotaConfigSchema);
