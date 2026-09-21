const { mongoose } = require('../config/db');

/** Single settings document for the partner / commission programme (edited by the admin). */
const partnerConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'main', unique: true },
    hold_days:  { type: Number, default: 7, min: 0 },    // days after payment before a commission is payable
    min_payout: { type: Number, default: 500, min: 0 },  // rupees; below this the balance carries forward
    // Defaults offered when the admin turns commission on for a teacher (per-teacher values override).
    youtube_flat: { type: Number, default: 30, min: 0 },
    school_percent: { type: Number, default: 15, min: 0, max: 100 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

module.exports = mongoose.models.PartnerConfig || mongoose.model('PartnerConfig', partnerConfigSchema);
