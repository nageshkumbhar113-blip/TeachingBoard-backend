const { mongoose } = require('../config/db');

// Help bot: the admin's own version of the questions/answers (null = the
// built-in ones in core/helpBot.js), and how often each answer was opened.
const helpConfigSchema = new mongoose.Schema(
  {
    key:        { type: String, default: 'main', unique: true },
    faq:        { type: mongoose.Schema.Types.Mixed, default: null },
    updated_at: { type: Date, default: null },
    // { "<item id>": { asked: n, unresolved: n } }
    stats:      { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { versionKey: false, minimize: false }
);

module.exports = mongoose.models.HelpConfig || mongoose.model('HelpConfig', helpConfigSchema);
