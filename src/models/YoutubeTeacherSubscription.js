const { mongoose } = require('../config/db');

/**
 * YoutubeTeacherSubscription — field set deliberately mirrors
 * StudentSubscription (src/models/StudentSubscription.js) so the existing
 * Razorpay webhook / verify pattern (razorpay.js, paymentController.js)
 * can be reused as-is, just branching on order.notes.type.
 */
const youtubeTeacherSubscriptionSchema = new mongoose.Schema(
  {
    youtube_teacher_id: { type: mongoose.Schema.Types.ObjectId, ref: 'YoutubeTeacherPartner', required: true, index: true },

    plan_type:  { type: String, enum: ['trial', 'monthly', 'yearly'], required: true },
    is_premium: { type: Boolean, default: false }, // independent add-on, on top of either plan

    amount:   { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'INR' },

    razorpay_order_id:   { type: String, index: true, default: '' },
    razorpay_payment_id: { type: String, unique: true, sparse: true },
    razorpay_signature:  { type: String, default: '' },
    payment_verified:    { type: Boolean, default: false, index: true },

    status: {
      type: String,
      enum: ['created', 'active', 'expired', 'cancelled', 'failed'],
      default: 'created',
      index: true,
    },
    start_date:  { type: Date, default: null },
    expiry_date: { type: Date, default: null, index: true },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

youtubeTeacherSubscriptionSchema.index({ youtube_teacher_id: 1, status: 1 });

// Same trial/monthly/yearly day math as StudentSubscription, minus the
// academic-year (April 30) cap — that cap is specific to the school-year
// student model and doesn't apply to YouTube teacher partners.
youtubeTeacherSubscriptionSchema.statics.computeExpiry = function (planType, from = new Date(), trialDays = 3) {
  const d = new Date(from);
  if (planType === 'trial')   d.setDate(d.getDate() + (Number(trialDays) || 3));
  if (planType === 'monthly') d.setDate(d.getDate() + 30);
  if (planType === 'yearly')  d.setDate(d.getDate() + 365);
  return d;
};

// Where a newly paid plan starts: at the end of the teacher's current
// still-running plan (paid or trial), or now if none — so renewing early
// adds the new period instead of throwing away the days left. Same rule as
// student renewals (paymentController: base = expiry_date if in the future).
youtubeTeacherSubscriptionSchema.statics.renewalStart = async function (teacherId, excludeId) {
  const current = await this.findOne({
    youtube_teacher_id: teacherId,
    status: 'active',
    expiry_date: { $gt: new Date() },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).sort({ expiry_date: -1 }).lean();
  return current?.expiry_date ? new Date(current.expiry_date) : new Date();
};

module.exports = mongoose.models.YoutubeTeacherSubscription ||
  mongoose.model('YoutubeTeacherSubscription', youtubeTeacherSubscriptionSchema);
