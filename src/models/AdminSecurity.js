const { mongoose } = require('../config/db');

// Admin login security (owner 2026-11-22): Google Authenticator for the admin, remembered devices
// (30 days), one-time backup codes, and a short log of login attempts. One document (key 'main').
const adminSecuritySchema = new mongoose.Schema(
  {
    key:           { type: String, default: 'main', unique: true },
    totp_enc:      { type: String, default: '' },     // the authenticator secret, encrypted (utils/adminSecurity.js)
    pending_enc:   { type: String, default: '' },     // while the QR is being scanned, until the first code is confirmed
    totp_on:       { type: Boolean, default: false },
    enforce:       { type: Boolean, default: false }, // the code is required at login (the owner turns it on)
    last_step:     { type: Number, default: 0 },      // a code works only once
    recovery:      { type: [String], default: [] },   // sha256 of the unused backup codes
    devices: {
      type: [{ _id: false, id: String, hash: String, name: String, created_at: Date, last_used: Date, expires: Date }],
      default: [],
    },
    events: {
      type: [{ _id: false, at: Date, kind: String, ip: String, ua: String }],
      default: [],
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

module.exports = mongoose.models.AdminSecurity || mongoose.model('AdminSecurity', adminSecuritySchema);
