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
    user_id:  { type: String, required: true, unique: true, index: true, trim: true },
    name:     { type: String, required: true, trim: true, index: true },
    role:     { type: String, enum: ['admin', 'student'], required: true },
    pin_hash: { type: String, default: null },
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
