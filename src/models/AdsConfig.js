const { mongoose } = require('../config/db');

// Admin › Ads settings kept on the server (shared by every admin device).
// google_topups: money the admin paid into Google Ads (prepay). Google's API does not give the
// prepaid balance, so Admin shows an estimate: paid (less GST) − Google's own spend since then.
const topupSchema = new mongoose.Schema({
  amount: { type: Number, required: true, min: 1 },     // rupees paid (GST included)
  date:   { type: String, required: true },             // YYYY-MM-DD (IST)
  at:     { type: Date, default: Date.now },
}, { _id: false });

const adsConfigSchema = new mongoose.Schema(
  {
    key:           { type: String, default: 'main', unique: true },
    google_topups: { type: [topupSchema], default: [] },
  },
  { versionKey: false, minimize: false }
);

module.exports = mongoose.models.AdsConfig || mongoose.model('AdsConfig', adsConfigSchema);
