const { mongoose } = require('../config/db');

/**
 * StudentSubscription — one record per batch purchase / trial.
 * Keyed by string identifiers (student_user_id / student_code / batch name)
 * to match the rest of the codebase (User.user_id, assigned_batches store names).
 */
const studentSubscriptionSchema = new mongoose.Schema(
  {
    // Who
    student_user_id: { type: String, required: true, index: true, trim: true }, // User.user_id
    student_code:    { type: String, required: true, index: true, trim: true },

    // What
    batch:  { type: String, required: true, trim: true }, // batch name
    period: { type: String, enum: ['trial', 'monthly', 'yearly'], required: true },

    // Money (stored in rupees; Razorpay order uses paise)
    amount:   { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'INR' },

    // Razorpay
    razorpay_order_id:   { type: String, index: true, default: '' },
    razorpay_payment_id: { type: String, unique: true, sparse: true },
    razorpay_signature:  { type: String, default: '' },
    payment_verified:    { type: Boolean, default: false, index: true },

    // Lifecycle
    status: {
      type: String,
      enum: ['created', 'active', 'expired', 'cancelled', 'failed'],
      default: 'created',
      index: true,
    },
    is_trial:    { type: Boolean, default: false },
    start_date:  { type: Date, default: null },
    expiry_date: { type: Date, default: null, index: true },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

studentSubscriptionSchema.index({ student_code: 1, status: 1 });
studentSubscriptionSchema.index({ student_user_id: 1, batch: 1 });

// The academic year ends April 30 — students get promoted to the next class
// each year, so a subscription (monthly or yearly) should never grant access
// past that boundary even if its rolling period would otherwise extend
// further. Returns the nearest upcoming April 30 on/after `from`.
function _nextAprilThirty(from) {
  const year = from.getFullYear();
  const aprilThirtyThisYear = new Date(year, 3, 30, 23, 59, 59, 999); // month 3 = April
  return from <= aprilThirtyThisYear ? aprilThirtyThisYear : new Date(year + 1, 3, 30, 23, 59, 59, 999);
}

// Compute expiry from a start date + period.
studentSubscriptionSchema.statics.computeExpiry = function (period, from = new Date(), trialDays = 1) {
  const d = new Date(from);
  if (period === 'trial')   d.setDate(d.getDate() + (Number(trialDays) || 1));
  if (period === 'monthly') d.setDate(d.getDate() + 30);
  if (period === 'yearly')  d.setDate(d.getDate() + 365);

  if (period === 'monthly' || period === 'yearly') {
    const cap = _nextAprilThirty(from);
    if (d > cap) return cap;
  }
  return d;
};

module.exports = mongoose.models.StudentSubscription ||
  mongoose.model('StudentSubscription', studentSubscriptionSchema);
