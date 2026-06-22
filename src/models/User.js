const { mongoose } = require('../config/db');
const crypto       = require('crypto');

function _pinHash(pin, secret) {
  return crypto
    .createHmac('sha256', secret || 'dev-fallback')
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
    approved_at:      { type: Date, default: null },
    approved_by:      { type: String, default: '' },
    request_source:   { type: String, enum: ['admin', 'self'], default: 'admin' },
    last_login_at:    { type: Date, default: null },
    school_name:      { type: String, default: '', trim: true },
    device_id:        { type: String, default: null },
    device_bound_at:  { type: Date, default: null },
    shared_device:    { type: Boolean, default: false },

    // Teacher-specific
    teacher_code:       { type: String, unique: true, sparse: true, trim: true, index: true },
    assigned_students:  { type: [String], default: [] }, // array of student_codes

    // Parent-specific
    parent_code:  { type: String, unique: true, sparse: true, trim: true, index: true },
    children:     { type: [String], default: [] }, // array of student_codes

    // Shared: FCM device token for push notifications
    device_token: { type: String, default: null, trim: true },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

userSchema.statics.hashPin = function(pin) {
  const secret = process.env.JWT_SECRET || process.env.AUTH_SECRET || 'dev-fallback';
  return _pinHash(pin, secret);
};

userSchema.methods.verifyPin = function(pin) {
  if (!this.pin_hash) return false;
  const secret = process.env.JWT_SECRET || process.env.AUTH_SECRET || 'dev-fallback';
  return this.pin_hash === _pinHash(pin, secret);
};

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
