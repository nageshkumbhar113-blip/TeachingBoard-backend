const { mongoose } = require('../config/db');

const vocabSubjectConfigSchema = new mongoose.Schema(
  {
    batch:           { type: String, required: true, trim: true },
    subject:         { type: String, required: true, trim: true },
    active_sections: {
      type:    [String],
      enum:    ['listen', 'meaning', 'picture', 'spelling'],
      default: ['listen', 'meaning', 'picture', 'spelling'],
    },
  },
  { collection: 'vocab_subject_configs', versionKey: false }
);

vocabSubjectConfigSchema.index({ batch: 1, subject: 1 }, { unique: true });

module.exports = mongoose.model('VocabSubjectConfig', vocabSubjectConfigSchema);
