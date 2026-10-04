const { mongoose } = require('../config/db');

/**
 * SubscriberClaim — a student's self-declared "I subscribe to this YouTube
 * Teacher's channel" claim, awaiting that teacher's own manual approval
 * (they cross-check their own YouTube Studio "Recent Subscribers" list —
 * see PLAN: 50% Discount via Self-Claim + Teacher Manual Approval). Not a
 * cryptographic verification — approval is the teacher's own judgment call.
 */
const subscriberClaimSchema = new mongoose.Schema(
  {
    student_user_id: { type: String, required: true, index: true, trim: true }, // User.user_id
    student_code:    { type: String, required: true, trim: true },
    partner_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'YoutubeTeacherPartner', required: true, index: true },
    // Student-entered — what name the teacher should look for in their own
    // YouTube Studio "Recent Subscribers" list (may differ from their app name).
    youtube_display_name: { type: String, required: true, trim: true },

    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    reviewed_at: { type: Date, default: null },
    reviewed_by: { type: String, default: '' }, // partner's own _id (string)
  },
  {
    timestamps: { createdAt: 'claimed_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

// One active (pending or approved) claim per student+partner pair.
subscriberClaimSchema.index({ student_user_id: 1, partner_id: 1 });

module.exports = mongoose.models.SubscriberClaim ||
  mongoose.model('SubscriberClaim', subscriberClaimSchema);
