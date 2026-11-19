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
    // महा-Test (mode 'papers'): every paper on the same day, one after the other with a gap
    // (owner 2026-11-19: NMMS महा-Test = MAT, 1 hour gap, SAT) instead of one paper a week by turns.
    papers_same_day:  { type: Boolean, default: false },
    gap_minutes:      { type: Number, min: 0, max: 240, default: 60 },
    // 'daily' = "Paper Pattern Practice" (owner 2026-11-19): each paper at its own time on the chosen
    // days, e.g. NMMS MAT Mon–Fri 07:00 + Sat 16:00, SAT Mon–Sat 19:00. One batch-wide time: the paper
    // opens for everyone at once, may be started in the first `join_minutes`, and closes for everyone
    // after duration_minutes. The day's papers add up to one day total + rank (Home banner till the
    // next day's result). Questions: least used first. Patterns are per batch (NMMS is the first one).
    kind:             { type: String, enum: ['weekly', 'daily'], default: 'weekly' },
    slots: {
      type: [{
        _id: false,
        paper: { type: String, trim: true, required: true },            // a paper's name (papers[].name)
        dow:   { type: Number, min: 0, max: 6, required: true },          // 0 = Sunday (IST)
        time:  { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
      }],
      default: [],
    },
    join_minutes:     { type: Number, min: 0, max: 180, default: 0 },   // 0 = any time in the window
    start_date:       { type: String, default: '', match: /^$|^\d{4}-\d{2}-\d{2}$/ }, // IST dates, '' = no limit
    end_date:         { type: String, default: '', match: /^$|^\d{4}-\d{2}-\d{2}$/ },
    skip_dates:       { type: [String], default: [] },                    // holidays 'YYYY-MM-DD'
    banner_top:       { type: Number, min: 3, max: 10, default: 10 },     // how many toppers on the Home banner
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

module.exports = mongoose.models.WeeklySchedule || mongoose.model('WeeklySchedule', weeklyScheduleSchema);
