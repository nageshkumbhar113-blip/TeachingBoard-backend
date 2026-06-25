const { mongoose } = require('../config/db');
const { randomUUID } = require('crypto');

const noteSchema = new mongoose.Schema({
  note_id:              { type: String, required: true, unique: true, index: true, default: () => randomUUID() },
  title:                { type: String, required: true, trim: true },
  batch:                { type: String, required: true, trim: true },
  subject:              { type: String, required: true, trim: true },
  chapter:              { type: String, default: '', trim: true },
  cloudinary_url:       { type: String, required: true },   // server-only, NEVER sent to student
  cloudinary_public_id: { type: String, required: true },   // for Cloudinary destroy
  file_size_bytes:      { type: Number, default: 0 },
  view_count:           { type: Number, default: 0 },
  status:               { type: String, enum: ['active', 'archived'], default: 'active' },
  created_by:           { type: String, default: '' },
  created_at:           { type: Date, default: Date.now },
}, {
  timestamps: false,
  versionKey: false,
});

noteSchema.index({ batch: 1, subject: 1 });

module.exports = mongoose.model('Note', noteSchema);
