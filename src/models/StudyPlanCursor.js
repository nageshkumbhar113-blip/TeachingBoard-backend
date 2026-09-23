const { mongoose } = require('../config/db');

/**
 * StudyPlanCursor - one per (StudyPlan, subject): the subject's materialized, ordered list of
 * StudyItems (built once at plan creation from Notes concepts + Exercise groups, in catalog
 * chapter order, Notes before Exercise within a chapter) plus where daily generation has reached.
 *
 * This is purely OPERATIONAL state for generating tomorrow's tasks — it holds no progress
 * percentage or completion count. Progress/streak/on-track are always computed fresh from
 * StudyTask (the single source of truth for what a student actually did), never from this cursor,
 * so the two can never drift apart. See utils/studyPlan.js.
 */
const studyItemSchema = new mongoose.Schema(
  {
    itemType: { type: String, enum: ['notes', 'exercise', 'passage'], required: true },
    chapterId: { type: String, required: true, trim: true },
    chapterName: { type: String, default: '', trim: true },   // display snapshot
    refId: { type: String, required: true, trim: true },      // Concept._id (notes) or exerciseNo (exercise)
    label: { type: String, required: true, trim: true },      // e.g. "Photosynthesis" or "Exercise 2.1"
  },
  { _id: false }
);

const studyPlanCursorSchema = new mongoose.Schema(
  {
    studyPlanId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    subjectId:   { type: String, required: true, trim: true },
    items:       { type: [studyItemSchema], default: [] },      // frozen order, index = position
    nextItemIndex: { type: Number, default: 0, min: 0 },         // how many items already have a StudyTask created
    lastGeneratedDate: { type: String, default: '' },            // 'YYYY-MM-DD' — guards against double-generating a day
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

studyPlanCursorSchema.index({ studyPlanId: 1, subjectId: 1 }, { unique: true });

module.exports = mongoose.models.StudyPlanCursor || mongoose.model('StudyPlanCursor', studyPlanCursorSchema);
