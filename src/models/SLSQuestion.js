const { mongoose } = require("../config/db");

const questionDiagramSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true
    },
    caption: {
      type: String,
      trim: true
    },
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  },
  { _id: false }
);

const answerDiagramSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true
    },
    caption: {
      type: String,
      trim: true
    },
    stepNumber: Number,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  },
  { _id: true }
);

const slsQuestionSchema = new mongoose.Schema(
  {
    // Basic Info
    // Exercise questions are scoped by chapter + exerciseNo (textbook-style
    // "1.1", "1.2" numbering), not by a specific Concept/Note — a question
    // bank entry doesn't have to be tied to any single lesson. conceptId is
    // kept optional for any legacy concept-tied entries.
    conceptId: {
      type: String,
      default: '',
      index: true,
      trim: true
    },
    exerciseNo: {
      type: String,
      default: '',
      trim: true
    },
    chapterId: {
      type: String,
      required: true,
      index: true,
      trim: true
    },
    subjectId: {
      type: String,
      required: true,
      trim: true
    },
    batchId: {
      type: String,
      required: true,
      trim: true
    },

    // Question Content (Bilingual)
    questionText: {
      english: {
        type: String,
        required: true,
        trim: true
      },
      marathi: {
        type: String,
        trim: true,
        default: ''
      }
    },

    // Question Diagrams (if any)
    questionDiagrams: [questionDiagramSchema],

    // Answer Content (Bilingual)
    answerText: {
      english: {
        type: String,
        required: true,
        trim: true
      },
      marathi: {
        type: String,
        trim: true,
        default: ''
      }
    },

    // Answer Diagrams (solution steps)
    answerDiagrams: [answerDiagramSchema],

    // Marks Assignment
    marks: {
      type: Number,
      enum: [1, 2, 3, 4, 5],
      required: true
    },

    // Question Properties
    questionType: {
      type: String,
      enum: [
        'definition',
        'short_answer',
        'long_answer',
        'numerical',
        'diagram',
        'viva',
        'practical',
        'mcq'
      ],
      required: true
    },

    difficulty: {
      type: String,
      enum: ['easy', 'medium', 'hard'],
      required: true
    },

    // Board Frequency (for exam preparation)
    boardFrequency: {
      type: String,
      enum: ['important', 'frequently_asked', 'rarely_asked'],
      default: 'important'
    },

    // Usage Tracking
    usageCount: {
      type: Number,
      default: 0,
      index: true
    },

    usedInPapers: [
      {
        paperId: String,
        usedDate: Date,
        studentAttempts: {
          type: Number,
          default: 0
        },
        averageScore: {
          type: Number,
          default: 0
        }
      }
    ],

    // Analytics
    averageStudentScore: {
      type: Number,
      default: 0
    },

    totalAttempts: {
      type: Number,
      default: 0
    },

    correctAttempts: {
      type: Number,
      default: 0
    },

    // Status
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
      index: true
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

// Indexes for efficient queries
slsQuestionSchema.index({ conceptId: 1, marks: 1 });
slsQuestionSchema.index({ chapterId: 1, difficulty: 1 });
slsQuestionSchema.index({ batchId: 1, status: 1 });
slsQuestionSchema.index({ questionType: 1, boardFrequency: 1 });
slsQuestionSchema.index({ usageCount: 1, marks: 1 });
slsQuestionSchema.index({ status: 1, chapterId: 1 });
// Paper Builder's exact query shape (chapter + marks value + published-only),
// sorted least-used-first — covers filter and sort in one index.
slsQuestionSchema.index({ chapterId: 1, marks: 1, status: 1, usageCount: 1 });
// Exercise Manager's exact query shape: list distinct exercise numbers /
// questions for a chapter, or a specific chapter+exerciseNo group.
slsQuestionSchema.index({ chapterId: 1, exerciseNo: 1, status: 1 });

module.exports = mongoose.models.SLSQuestion || mongoose.model('SLSQuestion', slsQuestionSchema);
