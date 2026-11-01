const { mongoose } = require('../config/db');

// One generated महा-Test (one week, one class, one subject). The question
// snapshot (with answers) stays on the server; students get the questions
// without answers when the window opens, and the answers only after it closes.
const eventQuestionSchema = new mongoose.Schema(
  {
    q_id:        { type: String, required: true },
    type:        { type: String, default: 'mcq' },
    question:    { type: String, required: true },
    options:     { type: mongoose.Schema.Types.Mixed, default: {} },
    answer:      { type: String, required: true },
    explanation: { type: String, default: '' },
    image:       { type: String, default: null },
    option_images: { type: mongoose.Schema.Types.Mixed, default: {} },
    chapter:     { type: String, default: '' },
  },
  { _id: false }
);

const weeklyEventSchema = new mongoose.Schema(
  {
    schedule_id:      { type: String, required: true, index: true },
    batch:            { type: String, required: true, trim: true, index: true },
    subject:          { type: String, required: true, trim: true },
    title:            { type: String, default: 'महा-Test', trim: true },
    starts_at:        { type: Date, required: true, index: true },
    ends_at:          { type: Date, required: true, index: true },
    duration_minutes: { type: Number, required: true },
    open_to:          { type: String, default: 'all' },
    questions:        { type: [eventQuestionSchema], default: [] },
    // scheduled → (window) → results; 'skipped' when the subject had no questions.
    status:           { type: String, enum: ['scheduled', 'results', 'skipped'], default: 'scheduled', index: true },
    skip_reason:      { type: String, default: '' },
    results_at:       { type: Date, default: null },
    participants:     { type: Number, default: 0 },
    is_trial:         { type: Boolean, default: false },   // admin "try now" event
    // The paper is downloaded days ahead, encrypted with this key; the key is
    // handed out only from starts_at (a ~50-byte call), so the test itself
    // runs on the phone with no server load and nobody sees questions early.
    key_b64:          { type: String, default: '', select: false },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

module.exports = mongoose.models.WeeklyEvent || mongoose.model('WeeklyEvent', weeklyEventSchema);
