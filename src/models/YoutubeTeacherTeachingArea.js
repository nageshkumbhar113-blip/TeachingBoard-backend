const { mongoose } = require('../config/db');

/**
 * YoutubeTeacherTeachingArea — "I teach this Batch + Subject" declaration.
 * Just the checkbox-level declaration ("My Teaching Areas" screen); the
 * actual per-exercise video links live in YoutubeTeacherVideo. Uses
 * batchName/subjectName strings (not ObjectId refs) to match the existing
 * Batch/Question/Note identity model — see batchController.renameBatch.
 */
const youtubeTeacherTeachingAreaSchema = new mongoose.Schema(
  {
    youtube_teacher_id: { type: mongoose.Schema.Types.ObjectId, ref: 'YoutubeTeacherPartner', required: true, index: true },
    batch_name:   { type: String, required: true, trim: true },
    subject_name: { type: String, required: true, trim: true },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

youtubeTeacherTeachingAreaSchema.index(
  { youtube_teacher_id: 1, batch_name: 1, subject_name: 1 },
  { unique: true }
);

module.exports = mongoose.models.YoutubeTeacherTeachingArea ||
  mongoose.model('YoutubeTeacherTeachingArea', youtubeTeacherTeachingAreaSchema);
