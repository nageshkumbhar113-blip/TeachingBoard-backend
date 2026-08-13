const { mongoose } = require('../config/db');
const bcrypt = require('bcryptjs');

/**
 * YoutubeTeacherPartner — an external YouTube-content-creator teacher who
 * registers to add exercise-wise videos for students. Explicitly separate
 * from the existing in-app `User` (role:'teacher') identity model — this is
 * a different kind of "teacher" (content partner, not a school teacher with
 * assigned students). Own collection, own email+password auth, but reuses
 * the same JWT (`utils/token.js`) so existing middleware conventions apply.
 */
const youtubeTeacherPartnerSchema = new mongoose.Schema(
  {
    name:            { type: String, required: true, trim: true },
    mobile:          { type: String, required: true, unique: true, trim: true, index: true },
    email:           { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
    password_hash:   { type: String, required: true },
    profile_photo:   { type: String, default: '' }, // Cloudinary URL, same pattern as other image uploads
    bio:             { type: String, default: '', trim: true },
    teaching_subject:{ type: String, default: '', trim: true }, // free-text profile tag, not linked to a Batch

    youtube_channel_url:  { type: String, default: '', trim: true },
    youtube_channel_name: { type: String, default: '', trim: true },
    youtube_channel_id:   { type: String, default: '', trim: true },
    channel_verified:     { type: Boolean, default: false },
    channel_verified_at:  { type: Date, default: null },
    channel_verified_by:  { type: String, default: '' }, // admin user_id

    intro_video_id: { type: String, default: '' }, // optional demo/intro video, shown on student-side teacher card

    status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active', index: true },
    terms_accepted_at: { type: Date, default: null },

    delete_requested_at: { type: Date, default: null }, // "Delete Account" request — Admin actions it
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

youtubeTeacherPartnerSchema.statics.hashPassword = function (password) {
  return bcrypt.hashSync(String(password || ''), 10);
};

youtubeTeacherPartnerSchema.methods.verifyPassword = function (password) {
  if (!this.password_hash) return false;
  return bcrypt.compareSync(String(password || ''), this.password_hash);
};

module.exports = mongoose.models.YoutubeTeacherPartner ||
  mongoose.model('YoutubeTeacherPartner', youtubeTeacherPartnerSchema);
