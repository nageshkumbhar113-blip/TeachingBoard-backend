const { mongoose } = require("../config/db");

const conceptVersionSchema = new mongoose.Schema(
  {
    conceptId: {
      type: String,
      required: true,
      index: true,
      trim: true
    },
    versionNumber: {
      type: Number,
      required: true
    },
    snapshot: mongoose.Schema.Types.Mixed,
    changesSummary: String,
    changedBy: String,
    changedAt: {
      type: Date,
      default: Date.now
    },
    canRestore: {
      type: Boolean,
      default: true
    },
    created_at: {
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

conceptVersionSchema.index({ conceptId: 1, versionNumber: 1 });

module.exports = mongoose.models.ConceptVersion || mongoose.model('ConceptVersion', conceptVersionSchema);
