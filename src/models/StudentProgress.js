const { mongoose } = require("../config/db");

const studentProgressSchema = new mongoose.Schema(
  {
    student_code: {
      type: String,
      required: true,
      uppercase: true,
      index: true,
      trim: true
    },
    conceptId: {
      type: String,
      required: true,
      index: true,
      trim: true
    },
    status: {
      type: String,
      enum: ['not_started', 'reading', 'completed', 'reviewed'],
      default: 'not_started'
    },
    readingTime: {
      type: Number,
      default: 0
    },
    lastAccessedAt: Date,
    completedAt: Date,
    reviewCount: {
      type: Number,
      default: 0
    },
    preferredLanguage: {
      type: String,
      enum: ['english', 'marathi'],
      default: 'english'
    },
    preferredStudyMode: {
      type: String,
      enum: ['read', 'exam', 'revision'],
      default: 'read'
    },
    created_at: {
      type: Date,
      required: true,
      default: Date.now
    },
    updated_at: {
      type: Date,
      required: true,
      default: Date.now
    }
  },
  {
    versionKey: false,
    strict: 'throw'
  }
);

studentProgressSchema.index({ student_code: 1, conceptId: 1 }, { unique: true });
studentProgressSchema.index({ student_code: 1, status: 1 });

module.exports = mongoose.models.StudentProgress || mongoose.model('StudentProgress', studentProgressSchema);
