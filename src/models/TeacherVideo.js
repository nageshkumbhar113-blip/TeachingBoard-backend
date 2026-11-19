const { mongoose } = require('../config/db');

/**
 * TeacherVideo — 🎬 a school teacher's own YouTube video for THEIR OWN students (owner 2026-11-19: the
 * YouTube-partner programme is closed; teachers get a "Videos" tab instead). The teacher pastes a YouTube
 * link; only students in that teacher's assigned_students list see it (optionally only one batch of them).
 * It can sit on a chapter's Exercise / Notes concept / Test, so the student finds it right there; without
 * that it shows in the student's "माझ्या सरांचे Videos" list. No admin approval: it never reaches another
 * teacher's students. The admin can still see every video and remove one.
 */
const teacherVideoSchema = new mongoose.Schema(
  {
    teacher_id:   { type: String, required: true, index: true },   // User.user_id of the teacher
    teacher_code: { type: String, default: '', trim: true },
    teacher_name: { type: String, default: '', trim: true },        // snapshot, for the student's list
    title:        { type: String, required: true, trim: true, maxlength: 120 },
    video_id:     { type: String, required: true, trim: true },    // the 11-character YouTube id
    // who sees it: '' = all of this teacher's students, else only those in this batch
    batch:        { type: String, default: '', trim: true },
    // where it sits (optional): a chapter, and in it an Exercise / a Notes concept / a Test
    subject:      { type: String, default: '', trim: true },
    chapter:      { type: String, default: '', trim: true },
    exercise_no:  { type: String, default: '', trim: true },
    concept_id:   { type: String, default: '', trim: true },
    concept_title:{ type: String, default: '', trim: true },
    quiz_id:      { type: String, default: '', trim: true },
    quiz_title:   { type: String, default: '', trim: true },
    hidden:       { type: Boolean, default: false, index: true },   // the teacher can hide it without deleting
    removed_by_admin: { type: Boolean, default: false, index: true },
    open_count:   { type: Number, default: 0 },
    viewers:      { type: [String], default: [] },                  // student codes that opened it (for "N students watched")
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

teacherVideoSchema.index({ teacher_id: 1, created_at: -1 });
teacherVideoSchema.index({ quiz_id: 1 });
teacherVideoSchema.index({ concept_id: 1 });
teacherVideoSchema.index({ batch: 1, subject: 1, chapter: 1, exercise_no: 1 });

module.exports = mongoose.models.TeacherVideo || mongoose.model('TeacherVideo', teacherVideoSchema);
