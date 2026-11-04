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
    // 'subject' = one subject a week (above); 'papers' = the admin's mixed papers below, taking turns
    // week by week (e.g. NMMS: MAT, SAT, MAT…). A paper takes `count` random questions from each
    // part (a subject, all or some chapters), each worth `marks`; `order` 'sections' keeps the parts
    // in the given order, 'mix' shuffles everything; `negative` is taken off for each wrong answer.
    mode:             { type: String, enum: ['subject', 'papers'], default: 'subject' },
    papers: {
      type: [{
        _id: false,
        name:     { type: String, trim: true, maxlength: 60, required: true },
        order:    { type: String, enum: ['sections', 'mix'], default: 'sections' },
        negative: { type: Number, min: 0, max: 10, default: 0 },
        parts: {
          type: [{
            _id: false,
            subject:  { type: String, trim: true, required: true },
            chapters: { type: [String], default: [] },             // empty = all chapters
            count:    { type: Number, min: 1, max: 200, default: 10 },
            marks:    { type: Number, min: 0.25, max: 20, default: 1 },
          }],
          default: [],
        },
      }],
      default: [],
    },
    next_paper_index: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

module.exports = mongoose.models.WeeklySchedule || mongoose.model('WeeklySchedule', weeklyScheduleSchema);
