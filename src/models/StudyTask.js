const { mongoose } = require('../config/db');

/**
 * StudyTask - one StudyItem scheduled on one day, for one student. This is the single source of
 * truth for progress: every %, streak and on-track figure is computed by counting these, never
 * stored redundantly elsewhere (see StudyPlanCursor's doc-comment).
 *
 *   pending   - scheduled, not done yet. A pending task whose date has passed is carried forward
 *               to today (its `date` is updated in place) rather than duplicated — see
 *               utils/studyPlan.js's generateTasksForDate.
 *   completed - the student ticked it. completedAt is set once and never cleared by carry-forward.
 *   skipped   - the student explicitly chose to skip it ("I already know this") — distinct from a
 *               task simply not done in time, which stays pending and carries forward instead.
 */
const studyTaskSchema = new mongoose.Schema(
  {
    studyPlanId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    studentUserId: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true }, // 'YYYY-MM-DD', local plan date — the day this is scheduled for

    subjectId:  { type: String, required: true, trim: true },
    chapterId:  { type: String, required: true, trim: true },
    chapterName: { type: String, default: '', trim: true },
    itemType:   { type: String, enum: ['notes', 'exercise', 'passage', 'mcq'], required: true },
    refId:      { type: String, required: true, trim: true },
    label:      { type: String, required: true, trim: true },
    sequence:   { type: Number, default: 0 }, // display order within the day

    status: { type: String, enum: ['pending', 'completed', 'skipped'], default: 'pending', index: true },
    completedAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

studyTaskSchema.index({ studyPlanId: 1, date: 1, sequence: 1 });
studyTaskSchema.index({ studyPlanId: 1, subjectId: 1, status: 1 });
// A given StudyItem is only ever scheduled once per plan (carried forward by moving its date, not duplicated).
studyTaskSchema.index({ studyPlanId: 1, subjectId: 1, itemType: 1, refId: 1 }, { unique: true });

module.exports = mongoose.models.StudyTask || mongoose.model('StudyTask', studyTaskSchema);
