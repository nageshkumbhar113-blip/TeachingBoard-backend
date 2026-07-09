const { mongoose } = require('../config/db');
const { randomUUID } = require('crypto');

const answerSchema = new mongoose.Schema({
  question_id:  { type: String, required: true },
  selected_id:  { type: String, default: null },  // 'A'|'B'|'C'|'D' or typed string or null (skipped)
  is_correct:   { type: Boolean, default: false },
  time_ms:      { type: Number, default: 0 },
}, { _id: false, versionKey: false });

const sectionSchema = new mongoose.Schema({
  score: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
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
  section_scores: {
    listening:  { type: sectionSchema, default: () => ({ score: 0, total: 0 }) },
    vocabulary: { type: sectionSchema, default: () => ({ score: 0, total: 0 }) },
    spelling:   { type: sectionSchema, default: () => ({ score: 0, total: 0 }) },
  },
  weak_word_ids: { type: [String], default: [] },
}, { collection: 'word_test_attempts', versionKey: false });

wordTestAttemptSchema.index({ test_id: 1, student_code: 1 });
wordTestAttemptSchema.index({ batch: 1, subject: 1 }); // classAnalytics filters by batch+subject

module.exports = mongoose.model('WordTestAttempt', wordTestAttemptSchema);
