const { mongoose } = require('../config/db');

// One small row per person per day (IST date): how much the app was used.
// The phone counts and keeps it locally; it uploads only after the admin asks
// (UsageRequest), so the server is touched only then (Admin > 📊 Usage).
// Rows delete themselves after ~13 months, enough to compare a whole year.
const usageDaySchema = new mongoose.Schema(
  {
    code:     { type: String, required: true, trim: true },          // student / teacher / shop code
    role:     { type: String, enum: ['student', 'teacher', 'shop'], required: true },
    date:     { type: String, required: true },                       // 'YYYY-MM-DD' (IST)
    day_at:   { type: Date, required: true },                         // for the auto-delete
    minutes:  { type: Number, default: 0 },
    opens:    { type: Number, default: 0 },
    tests:    { type: Number, default: 0 },
    notes:    { type: Number, default: 0 },
    exercise: { type: Number, default: 0 },
    words:    { type: Number, default: 0 },
    weekly:   { type: Number, default: 0 },
    papers:   { type: Number, default: 0 },   // teacher: papers made
    notifs:   { type: Number, default: 0 },   // teacher: notifications sent
    invites:  { type: Number, default: 0 },   // shop: parents sent the link
    uploaded_at: { type: Date, default: null },  // last upload (to count phones that answered a request)
  },
  { versionKey: false }
);

usageDaySchema.index({ code: 1, date: 1 }, { unique: true });
usageDaySchema.index({ role: 1, date: 1 });
usageDaySchema.index({ day_at: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });

module.exports = mongoose.models.UsageDay || mongoose.model('UsageDay', usageDaySchema);
