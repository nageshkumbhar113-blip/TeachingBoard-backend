const { mongoose } = require("../config/db");

const marksBreakdownSchema = new mongoose.Schema(
  {
    marks: Number,
    count: Number,
    totalMarksForThisValue: Number
  },
  { _id: false }
);

const questionInPaperSchema = new mongoose.Schema(
  {
    questionId: {
      type: String,
      required: true
    },
    marks: {
      type: Number,
      enum: [1, 2, 3, 4, 5],
      required: true
    },
    difficulty: {
      type: String,
      enum: ['easy', 'medium', 'hard'],
      required: true
    },
    questionType: String,
    displayOrder: {
      type: Number,
      required: true
    },
    totalAttempts: {
      type: Number,
      default: 0
    },
    correctAttempts: {
      type: Number,
      default: 0
    },
    averageScore: {
      type: Number,
      default: 0
    }
  },
  { _id: true }
);

const practicePaperSchema = new mongoose.Schema(
  {
    // Basic Info
    chapterId: {
      type: String,
      required: true,
      index: true,
      trim: true
    },
    batchId: {
      type: String,
      required: true,
      trim: true
    },
    subjectId: {
      type: String,
      required: true,
      trim: true
    },

    // Paper Details
    paperNumber: {
      type: Number,
      required: true
    },

    paperTitle: {
      type: String,
      trim: true
    },

    totalMarks: {
      type: Number,
      required: true
    },

    totalQuestions: {
      type: Number,
      required: true
    },

    timeLimit: {
      type: Number,
      default: 60
    },

    // Questions in Paper
    questions: [questionInPaperSchema],

    // Paper Generation Details
    generationFilters: {
      difficulty: {
        type: String,
        enum: ['easy', 'medium', 'hard', 'mixed'],
        default: 'mixed'
      },
      questionTypes: [String],
      boardFrequency: [String],
      usageFilters: {
        includeRecent: Boolean,
        includeFrequent: Boolean,
        includeRare: Boolean
      }
    },

    // Marks Breakdown (for algorithm accuracy verification)
    marksBreakdown: [marksBreakdownSchema],

    // PDF Generation
    showAnswersInPaper: {
      type: Boolean,
      default: false
    },

    // Algorithm Info
    algorithmVersion: {
      type: String,
      default: '1.0'
    },

    generatedAt: Date,

    // Paper Status
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
      index: true
    },

    // Analytics
    totalAttempts: {
      type: Number,
      default: 0
    },

    averageScore: {
      type: Number,
      default: 0
    },

    averageTimeSpent: {
      type: Number,
      default: 0
    },

    completionRate: {
      type: Number,
      default: 0
    },

    // Metadata
    createdBy: {
      type: String,
      required: true
    },

    lastModifiedBy: String,

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

// Indexes
practicePaperSchema.index({ chapterId: 1, paperNumber: 1 });
practicePaperSchema.index({ batchId: 1, status: 1 });
practicePaperSchema.index({ status: 1, createdAt: -1 });
practicePaperSchema.index({ 'questions.questionId': 1 });

module.exports = mongoose.models.PracticePaper || mongoose.model('PracticePaper', practicePaperSchema);
