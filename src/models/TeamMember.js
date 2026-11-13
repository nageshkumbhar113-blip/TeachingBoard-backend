const { mongoose } = require('../config/db');

// 👥 a team member (sub-admin) who talks to parents: the "NKs Team" app (CRM only). Made by the admin
// (Admin › Settings › 👥 Team); logs in with mobile + PIN. No access to money, content or settings.
const teamMemberSchema = new mongoose.Schema(
  {
    member_id:  { type: String, required: true, unique: true, trim: true },
    name:       { type: String, required: true, trim: true },
    mobile:     { type: String, required: true, unique: true, trim: true },   // 10 digits
    pin_hash:   { type: String, required: true },
    active:     { type: Boolean, default: true },
    last_login_at: { type: Date, default: null },
    // a PIN change / switching off logs every phone out (tokens issued before this are refused)
    tokens_valid_after: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

module.exports = mongoose.models.TeamMember || mongoose.model('TeamMember', teamMemberSchema);
