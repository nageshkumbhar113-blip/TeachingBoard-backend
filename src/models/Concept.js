const { mongoose } = require("../config/db");

const editorBlockSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        'paragraph', 'heading', 'image', 'table',
        'note_box', 'warning_box', 'formula', 'quote',
        'checklist', 'divider', 'callout'
      ],
      required: true
    },
    data: mongoose.Schema.Types.Mixed
  },
  { _id: false }
);

const attachmentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['pdf', 'image', 'audio', 'video', 'external_link'],
      required: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    url: {
      type: String,
      required: true
    },
    fileSize: Number,
    duration: Number,
    language: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  },
  { _id: true }
);

const revisionBoxSchema = new mongoose.Schema(
  {
    remember: [{ type: String, trim: true }],
    mistakes: [{ type: String, trim: true }],
    formulas: [{ type: String, trim: true }],
    examTips: [{ type: String, trim: true }]
  },
  { _id: false }
);

const studyModesSchema = new mongoose.Schema(
  {
    readMode: {
      content: { type: String, default: 'description' },
      showAttachments: { type: Boolean, default: true },
      showFormulas: { type: Boolean, default: true }
    },
    examMode: {
      content: { type: String, default: 'shortNotes' },
      showAttachments: { type: Boolean, default: false },
      showFormulas: { type: Boolean, default: true },
      highlightExamTopics: { type: Boolean, default: true }
    },
    revisionMode: {
      content: { type: String, default: 'oneLiner' },
      showAttachments: { type: Boolean, default: false },
      showFormulas: { type: Boolean, default: true },
      showRevisionBox: { type: Boolean, default: true }
    }
  },
  { _id: false }
);

const aiContextSchema = new mongoose.Schema(
  {
    board: {
      type: String,
      enum: ['CBSE', 'ICSE', 'STATE_BOARD'],
      default: 'CBSE'
    },
    standard: Number,
    medium: {
      type: String,
      enum: ['english', 'marathi', 'hindi'],
      default: 'english'
    },
    subject: String,
    chapter: String,
    conceptName: String,
    difficulty: {
      type: String,
      enum: ['easy', 'medium', 'hard'],
      default: 'easy'
    },
    keywords: [String],
    learningOutcomeCount: Number,
    hasNumerical: Boolean,
    hasDiagram: Boolean
  },
  { _id: false }
);

const analyticsSchema = new mongoose.Schema(
  {
    totalViews: { type: Number, default: 0 },
    averageReadingTime: { type: Number, default: 0 },
    studentEngagement: { type: Number, default: 0 },
    practiceAttempts: { type: Number, default: 0 },
    averagePracticeScore: { type: Number, default: 0 },
    skipRate: { type: Number, default: 0 },
    bookmarkCount: { type: Number, default: 0 },
    lastUpdatedAnalytics: Date
  },
  { _id: false }
);

const conceptSchema = new mongoose.Schema(
  {
    chapterId: {
      type: String,
      required: true,
      index: true,
      trim: true
    },
    language: {
      type: String,
      enum: ['english', 'marathi', 'bilingual'],
      default: 'english',
      required: true
    },
    title: {
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
    learningOutcomes: {
      english: [{ type: String, trim: true }],
      marathi: [{ type: String, trim: true }]
    },
    description: {
      english: {
        blocks: [editorBlockSchema],
        version: { type: String, default: '2.0' }
      },
      marathi: {
        blocks: [editorBlockSchema],
        version: { type: String, default: '2.0' }
      }
    },
    shortNotes: {
      english: [{ type: String, trim: true }],
      marathi: [{ type: String, trim: true }]
    },
    revisionBox: {
      english: revisionBoxSchema,
      marathi: revisionBoxSchema
    },
    attachments: [attachmentSchema],
    relatedConceptIds: [String],
    examTags: {
      type: [{
        type: String,
        enum: [
          'board_exam', 'important', 'repeated',
          'numerical', 'theory', 'diagram', 'viva', 'mcq'
        ]
      }],
      default: []
    },
    studyModes: studyModesSchema,
    aiContext: aiContextSchema,
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
      index: true
    },
    order: {
      type: Number,
      required: true,
      index: true
    },
    createdBy: {
      type: String,
      required: true
    },
    publishedAt: Date,
    lastModifiedBy: String,
    versions: [{
      versionNumber: Number,
      createdBy: String,
      createdAt: { type: Date, default: Date.now },
      changes: String
    }],
    analytics: analyticsSchema,
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

conceptSchema.index({ chapterId: 1, order: 1 });
// language_override: our own `language` field (english/marathi/bilingual) is
// NOT a MongoDB text-search stemmer name, but MongoDB's text index reserves
// the field name "language" by default to pick per-document search language.
// Inserting language:'marathi' (or 'bilingual') then fails at the database
// level with "language override unsupported: marathi" -- nothing to do with
// our own validation. Point MongoDB at an unused field name instead so it
// never touches our schema's `language` field.
conceptSchema.index(
  { 'title.english': 'text', 'title.marathi': 'text' },
  { language_override: 'textSearchLanguage' }
);
conceptSchema.index({ status: 1, chapterId: 1 });
conceptSchema.index({ examTags: 1 });

module.exports = mongoose.models.Concept || mongoose.model('Concept', conceptSchema);
