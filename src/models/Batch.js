const { mongoose } = require('../config/db');

const chapterSchema = new mongoose.Schema(
  { name: { type: String, required: true, trim: true } },
  { _id: false }
);

const subjectSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    chapters: { type: [chapterSchema], default: [] },
  },
  { _id: false }
);

const batchSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, unique: true, trim: true },
    icon:     { type: String, default: '📚', trim: true },
    subjects: { type: [subjectSchema], default: [] },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

module.exports = mongoose.models.Batch || mongoose.model('Batch', batchSchema);
