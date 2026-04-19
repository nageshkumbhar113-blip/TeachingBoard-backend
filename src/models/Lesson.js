const { mongoose } = require('../config/db');

const lessonSchema = new mongoose.Schema(
  {
    lesson_id: { type: String, required: true, unique: true, index: true, trim: true },
    title:     { type: String, required: true, trim: true },
    content:   { type: mongoose.Schema.Types.Mixed, required: true },
    batch:     { type: String, default: '', trim: true, index: true },
    subject:   { type: String, default: '', trim: true, index: true },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

module.exports = mongoose.models.Lesson || mongoose.model('Lesson', lessonSchema);
