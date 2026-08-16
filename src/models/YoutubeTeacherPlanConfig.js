const { mongoose } = require('../config/db');

/**
 * YoutubeTeacherPlanConfig — a SINGLETON document (there's only ever one)
 * holding the YouTube Teacher subscription prices, admin-editable from
 * Admin → YouTube Teachers → Plan Pricing. All prices in rupees (matches
 * the Batch pricing convention — see Batch.js's monthly_price/yearly_price
 * — converted to paise only at the Razorpay order-creation boundary).
 *
 * Previously these were hardcoded constants in
 * youtubeTeacherPaymentController.js; the defaults below match those
 * original values exactly, so existing behavior is unchanged until an
 * admin actually edits them.
 */
const youtubeTeacherPlanConfigSchema = new mongoose.Schema(
  {
    monthly_price:          { type: Number, default: 499,  min: 0 },
    yearly_price:           { type: Number, default: 3999, min: 0 },
    premium_addon_monthly:  { type: Number, default: 199,  min: 0 },
    premium_addon_yearly:   { type: Number, default: 2388, min: 0 }, // 199 * 12
    trial_days:             { type: Number, default: 3,    min: 0 },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

// Always the same one document — create it with defaults on first read/write.
youtubeTeacherPlanConfigSchema.statics.getOrCreate = async function () {
  let doc = await this.findOne();
  if (!doc) doc = await this.create({});
  return doc;
};

module.exports = mongoose.models.YoutubeTeacherPlanConfig ||
  mongoose.model('YoutubeTeacherPlanConfig', youtubeTeacherPlanConfigSchema);
