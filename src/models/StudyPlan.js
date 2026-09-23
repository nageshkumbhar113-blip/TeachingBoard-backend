const { mongoose } = require('../config/db');

/**
 * StudyPlan - a student's day-count-based study schedule ("finish this syllabus by this date").
 * One StudyItem = one Notes concept OR one Exercise group (all questions sharing an exerciseNo).
 * No time/minutes anywhere in this system — everything is counted in whole StudyItems and days.
 *
 * Total item counts per subject are frozen here at creation time (subjects[].totalItems) so the
 * on-track/behind % never shifts just because content was added/removed later — changing scope
 * means starting a new plan (see studyPlanController.createPlan), not editing this one.
 */
const studyPlanSubjectSchema = new mongoose.Schema(
  {
    subjectId: { type: String, required: true, trim: true },
    chapterIds: { type: [String], default: [] }, // '' entries never occur; empty array = "all chapters of this subject"
    totalItems: { type: Number, default: 0, min: 0 }, // frozen at creation — see class doc-comment
  },
  { _id: false }
);

const studyPlanSchema = new mongoose.Schema(
  {
    studentUserId: { type: String, required: true, index: true },
    studentCode:   { type: String, required: true, index: true },
    batchId:       { type: String, required: true, trim: true },
    examName:      { type: String, required: true, trim: true },

    startDate:  { type: Date, required: true },  // the day the plan was created — elapsed-days math starts here
    targetDate: { type: Date, required: true },  // exam date / "finish by"
    offDaysOfWeek: { type: [Number], default: [] }, // 0=Sun..6=Sat, weekly off (no new items scheduled)
    revisionSharePercent: { type: Number, default: 15, min: 0, max: 50 }, // last N% of study days = revision-only, no new items
    maxItemsPerDay: { type: Number, default: 4, min: 1, max: 10 }, // hard per-subject daily cap — also enforced on catch-up/carry-forward, not just fresh scheduling

    subjects: { type: [studyPlanSubjectSchema], default: [] },
    totalItemsOverall: { type: Number, default: 0, min: 0 }, // sum of subjects[].totalItems, frozen with them

    status: { type: String, enum: ['active', 'completed', 'abandoned'], default: 'active', index: true },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

// One active plan per student at a time (a new plan must abandon the old one first).
studyPlanSchema.index({ studentUserId: 1, status: 1 });

module.exports = mongoose.models.StudyPlan || mongoose.model('StudyPlan', studyPlanSchema);
