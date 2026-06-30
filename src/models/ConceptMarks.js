const { mongoose } = require("../config/db");

const conceptMarksSchema = new mongoose.Schema(
  {
    // Basic Info
    conceptId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true
    },
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

    // Marks Configuration
    assignedMarks: [
      {
        type: Number,
        enum: [1, 2, 3, 4, 5]
      }
    ],

    // Question Availability by Marks
    questionsByMarks: {
      1: {
        type: Number,
        default: 0
      },
      2: {
        type: Number,
        default: 0
      },
      3: {
        type: Number,
        default: 0
      },
      4: {
        type: Number,
        default: 0
      },
      5: {
        type: Number,
        default: 0
      }
    },

    // Special Question Types (if concept covers these)
    hasViva: {
      type: Boolean,
      default: false
    },

    hasPractical: {
      type: Boolean,
      default: false
    },

    hasMCQ: {
      type: Boolean,
      default: false
    },

    // Weight for Smart Algorithm
    // Higher weight = concept will be selected more often in papers
    conceptWeight: {
      type: Number,
      default: 1.0
    },

    // Metadata
    lastUpdatedBy: String,

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

// Indexes
conceptMarksSchema.index({ conceptId: 1 });
conceptMarksSchema.index({ chapterId: 1 });
conceptMarksSchema.index({ batchId: 1 });

module.exports = mongoose.models.ConceptMarks || mongoose.model('ConceptMarks', conceptMarksSchema);
