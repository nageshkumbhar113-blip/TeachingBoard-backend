const { mongoose } = require('../config/db');
const { randomUUID } = require('crypto');

const answerSchema = new mongoose.Schema({
  question_id:  { type: String, required: true },
  selected_id:  { type: String, default: null },  // 'A'|'B'|'C'|'D' or typed string or null (skipped)
  is_correct:   { type: Boolean, default: false },
  time_ms:      { type: Number, default: 0 },
}, { _id: false, versionKey: false });

const wordTestAttemptSchema = new mongoose.Schema({
  attempt_id:   { type: String, required: true, unique: true, index: true, default: () => randomUUID() },
  test_id:      { type: String, required: true, index: true },
  student_code: { type: String, required: true, index: true },
  batch:        { type: String, default: '' },
  subject:      { type: String, default: '' },
  answers:      { type: [answerSchema], default: [] },
  score:        { type: Number, default: 0 },
  total:        { type: Number, default: 0 },
  passed:       { type: Boolean, default: false },
  submitted_at: { type: Date, default: () => new Date() },
}, { collection: 'word_test_attempts', versionKey: false });

wordTestAttemptSchema.index({ test_id: 1, student_code: 1 });

module.exports = mongoose.model('WordTestAttempt', wordTestAttemptSchema);
