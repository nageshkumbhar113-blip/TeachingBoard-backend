const { mongoose } = require('../config/db');
const { randomUUID } = require('crypto');

// Embedded question option
const WordTestOptionSchema = new mongoose.Schema({
  id:        { type: String, required: true },   // 'A'|'B'|'C'|'D'
  word_id:   { type: String, default: null },
  text:      { type: String, default: '' },
  image_url: { type: String, default: '' },
  emoji:     { type: String, default: '' },
  emoji_svg: { type: String, default: '' },      // base64 SVG data URL
  colour:    { type: String, default: '' },       // hex for colour option type
  is_correct:{ type: Boolean, default: false },
}, { _id: false, versionKey: false });

// Embedded question (one question per word)
const WordTestQuestionSchema = new mongoose.Schema({
  question_id:       { type: String, required: true, default: () => randomUUID() },
  word_id:           { type: String, required: true },
  type:              { type: String, required: true },  // 'listen_pick_picture' etc
  option_type:       { type: String, required: true },  // 'image'|'text'|'colour'|'typing'
  audio:             { type: Boolean, default: true },
  audio_word:        { type: String, required: true },  // word text for TTS
  question_label:    { type: String, default: '' },
  question_label_mr: { type: String, default: '' },
  question_template: { type: String, default: '' },
  options:           { type: [WordTestOptionSchema], default: [] },
  correct_id:        { type: String, default: '' },     // 'A'|'B'|'C'|'D'|'TYPED'
  seq_num:           { type: Number, required: true },
}, { _id: false, versionKey: false });

// Main WordTest document
const wordTestSchema = new mongoose.Schema({
  test_id:         { type: String, required: true, unique: true, index: true, default: () => randomUUID() },
  title:           { type: String, required: true, trim: true },
  batch:           { type: String, required: true, trim: true },
  subject:         { type: String, required: true, trim: true },
  status:          { type: String, enum: ['draft', 'published'], default: 'draft' },
  questions:       { type: [WordTestQuestionSchema], default: [] },
  total_questions: { type: Number, default: 0 },
  pass_percent:    { type: Number, default: 60 },
  created_by:      { type: String, default: '' },
  created_at:      { type: Date, default: () => new Date() },
  published_at:    { type: Date, default: null },
}, { collection: 'word_tests', versionKey: false });

wordTestSchema.index({ batch: 1, subject: 1 });
wordTestSchema.index({ batch: 1, subject: 1, status: 1 });

module.exports = mongoose.model('WordTest', wordTestSchema);
