const { mongoose } = require('../config/db');

const questionSchema = new mongoose.Schema(
  {
    q_id:       { type: String, required: true, unique: true, index: true, trim: true },
    question:   { type: String, required: true, trim: true },
    options:    { type: mongoose.Schema.Types.Mixed, default: {} },
    answer:     { type: String, required: true, trim: true },
    type:       { type: String, enum: ['mcq', 'tf', 'fib', 'mtp'], default: 'mcq' },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    batch:      { type: String, default: '', trim: true, index: true },
    subject:    { type: String, default: '', trim: true, index: true },
    chapter:    { type: String, default: '', trim: true },
    image:      { type: String, default: null },
    tags:       { type: [String], default: [] },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

module.exports = mongoose.models.Question || mongoose.model('Question', questionSchema);
