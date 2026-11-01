const { mongoose } = require('../config/db');

// The admin's "collect usage now" request (Admin > 📊 Usage). Phones keep their
// own usage and upload it only after a request, the next time the app is opened
// within `until` (8 days) — so the server is touched only when the admin asks.
const usageRequestSchema = new mongoose.Schema(
  {
    key:          { type: String, default: 'main', unique: true },
    requested_at: { type: Date, default: null },
    until:        { type: Date, default: null },
  },
  { versionKey: false }
);

module.exports = mongoose.models.UsageRequest || mongoose.model('UsageRequest', usageRequestSchema);
