const { mongoose } = require('../config/db');
const { randomUUID } = require('crypto');

const wordSchema = new mongoose.Schema(
  {
    word_id:       { type: String, required: true, unique: true, index: true, default: () => randomUUID() },
    word:          { type: String, required: true, trim: true },
    batch:         { type: String, required: true, trim: true },
    subject:       { type: String, required: true, trim: true },
    meaning_mr:    { type: String, default: '', trim: true },
    meaning_en:    { type: String, default: '', trim: true },
    pronunciation: { type: String, default: '', trim: true },
    phonics:       { type: String, default: '', trim: true },
    image_url:     { type: String, default: '', trim: true },
    emoji:         { type: String, default: '', trim: true },
    visual_type:    { type: String, enum: ['word', 'emoji', 'image'], default: 'word' },
    word_category:  { type: String, enum: ['general', 'color', 'number', 'alphabet'], default: 'general' },
    difficulty:     { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    tags:          [{ type: String, trim: true }],
    added_by:      { type: String, enum: ['admin', 'student'], default: 'admin' },
    added_by_code: { type: String, default: '', trim: true },
    seq_num:       { type: Number, required: true },
    created_at:    { type: Date, default: () => new Date() },
  },
  { collection: 'words', versionKey: false }
);

wordSchema.index({ batch: 1, subject: 1 });
wordSchema.index({ batch: 1, subject: 1, seq_num: 1 }, { unique: true });
wordSchema.index({ word: 'text' });

module.exports = mongoose.model('Word', wordSchema);
