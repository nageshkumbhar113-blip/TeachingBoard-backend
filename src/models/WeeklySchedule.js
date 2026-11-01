const { mongoose } = require('../config/db');

// "महा-Test" automation, set up once per class by the admin: every week on
// `day_of_week` at `start_time` (IST) the app makes a fresh test for the next
// subject in `subjects` (round robin), `question_count` random questions of
// the chosen `question_types` from the whole subject. See utils/weeklyTests.js.
const weeklyScheduleSchema = new mongoose.Schema(
  {
    batch:            { type: String, required: true, trim: true, index: true },
    title:            { type: String, default: 'महा-Test', trim: true, maxlength: 60 },
    enabled:          { type: Boolean, default: true },
    day_of_week:      { type: Number, min: 0, max: 6, default: 0 },          // 0 = Sunday (IST)
    start_time:       { type: String, default: '18:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    window_minutes:   { type: Number, min: 10, max: 24 * 60, default: 30 }, // may start any time in the window
    // Rank list + answers shown at this time the same day (IST), e.g. test 6:00–6:30, result 8:00.
    // '' = right when the window closes.
    result_time:      { type: String, default: '20:00', match: /^$|^([01]\d|2[0-3]):[0-5]\d$/ },
    duration_minutes: { type: Number, min: 5, max: 180, default: 30 },
    question_count:   { type: Number, min: 5, max: 100, default: 30 },
    question_types:   { type: [String], default: ['mcq'] },                  // mcq | tf | fib
    question_source:  { type: String, enum: ['bank', 'tests', 'both'], default: 'both' },
    subjects:         { type: [String], default: [] },                       // empty = every subject of the class
    next_subject_index: { type: Number, default: 0 },
    open_to:          { type: String, enum: ['all', 'paid'], default: 'all' }, // 'all' = free visitors too
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

module.exports = mongoose.models.WeeklySchedule || mongoose.model('WeeklySchedule', weeklyScheduleSchema);
