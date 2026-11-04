const { mongoose } = require('../config/db');

// A student's (or free visitor's) place in one महा-Test: registered → started →
// submitted (graded by the server) → rank once the window has closed.
const weeklyEntrySchema = new mongoose.Schema(
  {
    event_id:      { type: String, required: true, index: true },
    student_code:  { type: String, required: true, trim: true },
    name:          { type: String, default: '', trim: true },
    is_guest:      { type: Boolean, default: false },
    registered_at: { type: Date, default: Date.now },
    started_at:    { type: Date, default: null },
    order:         { type: [String], default: [] },   // this person's question order
    submitted_at:  { type: Date, default: null },
    answers:       { type: [{ _id: false, q_id: String, given: String }], default: [] },
    score:         { type: Number, default: 0 },
    total:         { type: Number, default: 0 },
    correct:       { type: Number, default: 0 },
    wrong:         { type: Number, default: 0 },
    skipped:       { type: Number, default: 0 },
    // mixed papers: marks per subject [{ subject, score, total, correct, wrong }]
    by_subject:    { type: [{ _id: false, subject: String, score: Number, total: Number, correct: Number, wrong: Number }], default: [] },
    time_taken:    { type: Number, default: 0 },      // seconds
    leave_count:   { type: Number, default: 0 },      // left the app during the test (reported)
    rank:          { type: Number, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

weeklyEntrySchema.index({ event_id: 1, student_code: 1 }, { unique: true });
weeklyEntrySchema.index({ event_id: 1, score: -1, time_taken: 1 });

module.exports = mongoose.models.WeeklyEntry || mongoose.model('WeeklyEntry', weeklyEntrySchema);
