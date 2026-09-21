const { mongoose } = require('../config/db');
const crypto       = require('crypto');

function _pinHash(pin, secret) {
  if (!secret) throw new Error('JWT_SECRET is required for PIN hashing');
  return crypto
    .createHmac('sha256', secret)
    .update(String(pin || ''))
    .digest('hex');
}

const userSchema = new mongoose.Schema(
  {
    user_id:          { type: String, required: true, unique: true, index: true, trim: true },
    name:             { type: String, required: true, trim: true, index: true },
    role:             { type: String, enum: ['admin', 'student', 'teacher', 'parent'], required: true },
    pin_hash:         { type: String, default: null },

    // Student-specific
    // default omitted so sparse index skips non-student users (default:null causes 11000 with multiple null values)
    student_code:     { type: String, unique: true, sparse: true, trim: true, index: true },
    mobile:           { type: String, default: '', trim: true },
    status:           { type: String, enum: ['pending', 'active', 'blocked'], default: 'active', index: true },
    assigned_batches: { type: [String], default: [] },
    expiry_date:      { type: Date, default: null, index: true },
    // Tracks which expiry_date the D-8 reminder cron already notified for —
    // prevents renotifying daily across the whole 8-day window, while still
    // firing again if the student renews and gets a new expiry_date.
    expiry_notified_for: { type: Date, default: null },
    approved_at:      { type: Date, default: null },
    approved_by:      { type: String, default: '' },
    request_source:   { type: String, enum: ['admin', 'self'], default: 'admin' },
    last_login_at:    { type: Date, default: null },
    school_name:      { type: String, default: '', trim: true },
    device_id:        { type: String, default: null },
    device_bound_at:  { type: Date, default: null },
    shared_device:    { type: Boolean, default: false },
    // Free-tier student: self-registered and has not paid yet — may open only
    // free chapters (utils/contentAccess.js). Cleared when a payment activates
    // them. Existing students default to false, i.e. nothing changes for them.
    free_tier:        { type: Boolean, default: false },

    // Teacher-specific
    teacher_code:       { type: String, unique: true, sparse: true, trim: true, index: true },
    assigned_students:  { type: [String], default: [] }, // array of student_codes
    fee_upi_id:         { type: String, default: '', trim: true },
    fee_upi_name:       { type: String, default: '', trim: true },
    // Admin-set last valid day for a teacher account (null = no limit). Kept separate from
    // expiry_date, which is derived from the teacher's students and is informational only.
    validity_until:     { type: Date, default: null },
    // Set when a teacher registers themselves (status starts 'pending' until an admin approves).
    institute_name:     { type: String, default: '', trim: true },
    // Board-style (exam look-alike) papers are off for teachers unless an admin allows them.
    board_papers_allowed: { type: Boolean, default: false },
    // Partner programme (YouTube teacher / school teacher earning a commission on linked students' payments).
    partner_type:       { type: String, enum: ['', 'school', 'youtube'], default: '' },
    commission_enabled: { type: Boolean, default: false },
    commission_mode:    { type: String, enum: ['flat', 'percent'], default: 'flat' },
    commission_value:   { type: Number, default: 0, min: 0 },   // rupees (flat) or percent
    commission_first_payment_only: { type: Boolean, default: true },
    payout_upi_id:      { type: String, default: '', trim: true },
    payout_name:        { type: String, default: '', trim: true },
    pan:                { type: String, default: '', trim: true },
    // Student side: the teacher/partner code the student registered with (set once).
    referred_by_teacher: { type: String, default: '', trim: true },
    terms_accepted_at:  { type: Date, default: null },
    terms_version:      { type: String, default: '' },
    // Paper Builder quota overrides (admin-set): batch name, or '*' for all batches.
    paper_quota_overrides: {
      type: [{
        _id: false,
        batch: { type: String, required: true, trim: true },
        mode: { type: String, enum: ['unlimited', 'custom'], required: true },
        free_papers: { type: Number, min: 0 },
        unlock_paid_students: { type: Number, min: 1 },
      }],
      default: [],
    },

    // Parent-specific
    parent_code:  { type: String, unique: true, sparse: true, trim: true, index: true },
    children:     { type: [String], default: [] }, // array of student_codes

    // Shared: FCM device token for push notifications
    device_token: { type: String, default: null, trim: true },

    // Student-specific: dedupe for the "haven't studied in N days" reminder
    // job (jobs/notificationScheduler.js) — without this it would re-fire
    // every single day once a student goes quiet, instead of once per gap.
    last_inactivity_reminder_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

// Admin student/teacher lists filter by role then sort by created_at —
// compound index covers both the filter and the sort in one pass.
userSchema.index({ role: 1, created_at: -1 });

userSchema.statics.hashPin = function(pin) {
  const secret = process.env.JWT_SECRET || process.env.AUTH_SECRET;
  return _pinHash(pin, secret);
};

userSchema.methods.verifyPin = function(pin) {
  if (!this.pin_hash) return false;
  const secret = process.env.JWT_SECRET || process.env.AUTH_SECRET;
  const computed = _pinHash(pin, secret);
  return crypto.timingSafeEqual(Buffer.from(this.pin_hash), Buffer.from(computed));
};

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
