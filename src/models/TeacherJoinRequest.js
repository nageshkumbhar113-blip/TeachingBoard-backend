const { mongoose } = require('../config/db');

// "Connect student": a record of each student who joined a teacher through the
// join link / QR / code (the student itself goes into User.assigned_students —
// for teaching only, see teacherConnectController for the commission rule).
const teacherJoinRequestSchema = new mongoose.Schema(
  {
    teacher_code: { type: String, required: true, trim: true, index: true },
    student_code: { type: String, required: true, trim: true, index: true },
    student_name: { type: String, default: '', trim: true },
    class:        { type: String, default: '', trim: true },
    via:          { type: String, default: 'link' },   // link | code
    status:       { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending', index: true },
    decided_at:   { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

teacherJoinRequestSchema.index({ teacher_code: 1, student_code: 1 }, { unique: true });

module.exports = mongoose.models.TeacherJoinRequest || mongoose.model('TeacherJoinRequest', teacherJoinRequestSchema);
