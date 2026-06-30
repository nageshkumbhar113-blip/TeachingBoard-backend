const { mongoose } = require("../config/db");

const studentAnswerSchema = new mongoose.Schema(
  {
    questionId: {
      type: String,
      required: true
    },
    marks: Number,
    studentAnswer: {
      text: String,
      diagrams: [String]
    },
    marksAwarded: {
      type: Number,
      default: 0
    },
    maxMarks: Number,
    feedback: {
      type: String,
      trim: true
    },
    isCorrect: {
      type: Boolean,
      default: false
    },
    evaluatedAt: Date,
    evaluatedBy: String
  },
  { _id: true }
);

const studentPaperAttemptSchema = new mongoose.Schema(
  {
    // Basic Info
    paperId: {
      type: String,
      required: true,
      index: true
    },
    studentId: {
      type: String,
      required: true,
      index: true
    },
    studentCode: {
      type: String,
      required: true,
      trim: true
    },
    batchId: {
      type: String,
      required: true,
      trim: true
    },

    // Paper Details
    totalMarks: {
      type: Number,
      required: true
    },
    totalQuestions: {
      type: Number,
      required: true
    },

    // Student Answers
    answers: [studentAnswerSchema],

    // Scoring
    totalMarksObtained: {
      type: Number,
      default: 0
    },

    percentage: {
      type: Number,
      default: 0
    },

    grade: {
      type: String,
      enum: ['A+', 'A', 'B+', 'B', 'C+', 'C', 'D', 'F'],
      default: 'F'
    },

    // Attempt Details
    attemptStartTime: Date,
    attemptEndTime: Date,
    timeSpent: {
      type: Number,
      default: 0
    },

    questionsAttempted: {
      type: Number,
      default: 0
    },

    correctAnswers: {
      type: Number,
      default: 0
    },

    partialAnswers: {
      type: Number,
      default: 0
    },

    // Status
    status: {
      type: String,
      enum: ['in_progress', 'submitted', 'evaluated', 'archived'],
      default: 'in_progress',
      index: true
    },

    // Evaluation
    evaluatedBy: String,
    evaluatedAt: Date,

    evaluationNotes: {
      type: String,
      trim: true
    },

    // Auto-Calculation (for MCQ/objective)
    autoEvaluated: {
      type: Boolean,
      default: false
    },

    // Question-wise Performance
    performanceBreakdown: [
      {
        questionId: String,
        marks: Number,
        awarded: Number,
        percentage: Number,
        difficulty: String,
        questionType: String
      }
    ],

    // Weak Areas Identified
    weakAreas: [
      {
        type: String,
        category: String,
        performancePercentage: Number
      }
    ],

    // Strong Areas Identified
    strongAreas: [
      {
        type: String,
        category: String,
        performancePercentage: Number
      }
    ],

    // Metadata
    created_at: {
      type: Date,
      required: true,
      default: Date.now,
      index: true
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

// Indexes for efficient queries
studentPaperAttemptSchema.index({ paperId: 1, studentId: 1 });
studentPaperAttemptSchema.index({ batchId: 1, status: 1 });
studentPaperAttemptSchema.index({ studentId: 1, status: 1 });
studentPaperAttemptSchema.index({ status: 1, created_at: -1 });
studentPaperAttemptSchema.index({ paperId: 1, status: 1 });

module.exports = mongoose.models.StudentPaperAttempt || mongoose.model('StudentPaperAttempt', studentPaperAttemptSchema);
