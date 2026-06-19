const { mongoose } = require('../config/db');

const appVersionSchema = new mongoose.Schema(
  {
    version_id:    { type: String, required: true, unique: true, index: true, trim: true },
    version:       { type: String, required: true, trim: true },
    apk_url:       { type: String, default: '', trim: true },
    release_notes: { type: String, default: '', trim: true },
    platform:      { type: String, enum: ['android', 'web', 'all'], default: 'android' },
    is_latest:     { type: Boolean, default: false, index: true },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

module.exports = mongoose.models.AppVersion || mongoose.model('AppVersion', appVersionSchema);
