const { mongoose } = require('../config/db');

// One Admin > Import run — kept so it can be listed and undone.
const importJobSchema = new mongoose.Schema(
  {
    job_id:  { type: String, required: true, unique: true, index: true },
    created_by: { type: String, default: '' },
    source:  { batch: String, subject: String },
    target:  { batch: String, subject: String },
    types:   { type: [String], default: [] },
    as_draft: { type: Boolean, default: false },
    results: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Catalog entries this job created, so Undo can remove them if left empty.
    created_subject: { type: Boolean, default: false },
    created_chapters: { type: [String], default: [] },
    undone: { type: Boolean, default: false },
    undone_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

module.exports = mongoose.models.ImportJob || mongoose.model('ImportJob', importJobSchema);
