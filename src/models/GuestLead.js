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
    // The class in the link they opened (Admin's per-class free link, ?batch=…); '' = picked a class themselves.
    link_batch:    { type: String, default: '', trim: true },
    // Came from a Facebook / Instagram ad: Meta's click id (fbc = fb.1.<ms>.<fbclid>) and the
    // browser's user agent — the only things sent to Meta with a result (Conversions API).
    fbc:           { type: String, default: '', trim: true },
    ua:            { type: String, default: '', trim: true },
    capi_lead_at:  { type: Date, default: null },
    capi_paid_at:  { type: Date, default: null },
    // Came from a Google / YouTube ad: Google's click id (one of the three) — the only thing sent
    // back to Google with a "Lead" (offline click conversion).
    gclid:         { type: String, default: '', trim: true },
    gbraid:        { type: String, default: '', trim: true },
    wbraid:        { type: String, default: '', trim: true },
    gads_lead_at:  { type: Date, default: null },
    // Funnel steps reached (opened, browsed, engaged, tested, shared_friend,
    // shared_parent, lead, offer_seen, checkout, paid).
    steps:         { type: [String], default: [] },
    tests:         { type: Number, default: 0 },
    best_pct:      { type: Number, default: 0 },
    last_test:     { type: String, default: '', trim: true },
    parent_mobile: { type: String, default: '', trim: true, index: true },
    consent_at:    { type: Date, default: null },
    // Test-completion offer: 50 % off the first payment (monthly or yearly), 24 hours, once a calendar month.
    offer: {
      percent:    { type: Number, default: 0 },
      issued_at:  { type: Date, default: null },
      expires_at: { type: Date, default: null },
      month:      { type: String, default: '' },   // IST 'YYYY-MM'
    },
    // App only: push token for the evening "next free test" reminder (max 7, then stops).
    device_token:   { type: String, default: '', trim: true },
    reminders_sent: { type: Number, default: 0 },
    last_reminder_date: { type: String, default: '' },   // IST 'YYYY-MM-DD'
    hide_in_toppers: { type: Boolean, default: false },   // name hidden on महा-Test toppers
    toppers_consent_at: { type: Date, default: null },     // parent's one-time tick at महा-Test registration
    converted_code: { type: String, default: '', trim: true },
    converted_at:   { type: Date, default: null },
    last_seen_at:   { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

guestLeadSchema.index({ created_at: -1 });

module.exports = mongoose.models.GuestLead || mongoose.model('GuestLead', guestLeadSchema);
