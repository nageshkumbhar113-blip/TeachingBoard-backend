const { mongoose } = require('../config/db');

const vocabAttemptSchema = new mongoose.Schema(
  {
    attempt_id:     { type: String, required: true, unique: true, index: true },
    student_code:   { type: String, required: true, trim: true, index: true },
    student_name:   { type: String, default: '', trim: true },
    batch:          { type: String, required: true, trim: true },
    subject:        { type: String, required: true, trim: true },
    test_num:       { type: Number, required: true },
    word_from:      { type: Number, required: true },
    word_to:        { type: Number, required: true },
    meaning_lang:   { type: String, enum: ['english', 'marathi'], default: 'marathi' },
    score_listen:   { type: Number, default: 0 },
    score_meaning:  { type: Number, default: 0 },
    score_picture:  { type: Number, default: 0 },
    score_spelling: { type: Number, default: 0 },
    total_score:    { type: Number, default: 0 },
    total_possible: { type: Number, default: 0 },
    passed:         { type: Boolean, default: false },
    submitted_at:   { type: Date, default: () => new Date(), index: true },
  },
  { collection: 'vocab_attempts', versionKey: false }
);

vocabAttemptSchema.index({ batch: 1, subject: 1 });
vocabAttemptSchema.index({ student_code: 1, test_num: 1, batch: 1, subject: 1 });

module.exports = mongoose.model('VocabAttempt', vocabAttemptSchema);
