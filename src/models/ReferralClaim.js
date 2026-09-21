const { mongoose } = require('../config/db');

/**
 * ReferralClaim - a student's request for a friend-referral prize (e.g. 5 paid friends -> Compass box).
 * The prize title is copied at claim time so later edits to the prize list never change an old claim.
 */
const referralClaimSchema = new mongoose.Schema(
  {
    student_user_id: { type: String, required: true, index: true },
    student_code:    { type: String, required: true, index: true },
    student_name:    { type: String, default: '' },
    milestone: { type: Number, required: true },   // friend count that unlocked the prize
    title:     { type: String, default: '' },      // prize name (snapshot)
    friends_at_claim: { type: Number, default: 0 },
    friends_used: { type: Number, default: 0 },    // friends spent by this claim (all that were ready)

    // Delivery details, given with a parent's consent
    recipient_name: { type: String, default: '' },
    phone:          { type: String, default: '' },
    address:        { type: String, default: '' },
    pincode:        { type: String, default: '' },
    parent_consent: { type: Boolean, default: false },

    status: { type: String, enum: ['requested', 'shipped', 'rejected'], default: 'requested', index: true },
    shipped_at: { type: Date, default: null },
    tracking:   { type: String, default: '' },
    note:       { type: String, default: '' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

// A student may claim again later with new friends, so there is no uniqueness on the milestone.
referralClaimSchema.index({ student_code: 1, milestone: 1 });

module.exports = mongoose.models.ReferralClaim || mongoose.model('ReferralClaim', referralClaimSchema);
