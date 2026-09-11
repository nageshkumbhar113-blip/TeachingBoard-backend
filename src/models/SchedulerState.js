const { mongoose } = require("../config/db");

// Tiny key/value store so the in-process daily scheduler (jobs/notificationScheduler.js)
// can tell "already ran today" apart from "server just restarted" — one row
// per named daily job, e.g. { key: 'daily_motivation', last_run_date: '2026-09-12' }.
const schedulerStateSchema = new mongoose.Schema(
  {
    key:           { type: String, required: true, unique: true, index: true },
    last_run_date: { type: String, default: '' }, // 'YYYY-MM-DD', local server date
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

module.exports = mongoose.model('SchedulerState', schedulerStateSchema);
