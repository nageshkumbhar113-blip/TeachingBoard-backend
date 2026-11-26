const { mongoose } = require('../config/db');

// One child's day in "Paper Pattern Practice" (or a महा-Test whose papers are all on one day):
// every paper of that day with its marks, the day total (e.g. NMMS MAT 90 + SAT 90 = 180) and the
// rank in the class by that total. Made again each time one of the day's papers gets its result.
const practiceDaySchema = new mongoose.Schema(
  {
    schedule_id:  { type: String, required: true },
    batch:        { type: String, required: true, trim: true, index: true },
    title:        { type: String, default: '' },
    kind:         { type: String, default: 'daily' },
    day_key:      { type: String, required: true },          // IST 'YYYY-MM-DD'
    student_code: { type: String, required: true, trim: true, index: true },
    name:         { type: String, default: '' },
    papers: {
      type: [{
        _id: false, event_id: String, subject: String, score: Number, total: Number, rank: Number,
        by_subject: { type: [{ _id: false, subject: String, score: Number, total: Number, correct: Number, wrong: Number }], default: [] },
      }],
      default: [],
    },
    score:        { type: Number, default: 0 },
    total:        { type: Number, default: 0 },               // all the day's papers (a paper not given counts 0)
    rank:         { type: Number, default: null },
    participants: { type: Number, default: 0 },
    final:        { type: Boolean, default: false },          // every paper of the day has its result
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

practiceDaySchema.index({ schedule_id: 1, day_key: 1, student_code: 1 }, { unique: true });
practiceDaySchema.index({ schedule_id: 1, day_key: 1, score: -1 });
practiceDaySchema.index({ student_code: 1, day_key: -1 });   // a child's days (Home card, 45-day report) without reading every day of the year (Admin audit 2026-11-27)

module.exports = mongoose.models.PracticeDay || mongoose.model('PracticeDay', practiceDaySchema);
