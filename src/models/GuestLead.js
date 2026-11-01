const { mongoose } = require('../config/db');

// A visitor of the free part who has not registered yet (guest token, no User
// row). Holds what the funnel and Admin > Leads need; when the guest pays or
// registers, `converted_code` points at the real student account.
const guestLeadSchema = new mongoose.Schema(
  {
    gid:           { type: String, required: true, unique: true, index: true, trim: true },
    name:          { type: String, default: '', trim: true },
    batch:         { type: String, default: '', trim: true },
    // How they arrived: 'admin' (general link), 'friend' (challenge link),
    // 'teacher' (teacher/partner code), '' (unknown). `ref` = the code / friend's guest id.
    source:        { type: String, default: '', trim: true, index: true },
    ref:           { type: String, default: '', trim: true },
    // Funnel steps reached (opened, browsed, engaged, tested, shared_friend,
    // shared_parent, lead, offer_seen, checkout, paid).
    steps:         { type: [String], default: [] },
    tests:         { type: Number, default: 0 },
    best_pct:      { type: Number, default: 0 },
    last_test:     { type: String, default: '', trim: true },
    parent_mobile: { type: String, default: '', trim: true, index: true },
    consent_at:    { type: Date, default: null },
    // Test-completion offer: 50 % off the first month, 12 hours, once a calendar month.
    offer: {
      percent:    { type: Number, default: 0 },
      issued_at:  { type: Date, default: null },
      expires_at: { type: Date, default: null },
      month:      { type: String, default: '' },   // IST 'YYYY-MM'
    },
    converted_code: { type: String, default: '', trim: true },
    converted_at:   { type: Date, default: null },
    last_seen_at:   { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

guestLeadSchema.index({ created_at: -1 });

module.exports = mongoose.models.GuestLead || mongoose.model('GuestLead', guestLeadSchema);
