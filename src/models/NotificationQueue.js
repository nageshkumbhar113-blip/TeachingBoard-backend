const { mongoose } = require("../config/db");

// Debounce buffer for events that fire many times in a row for one logical
// change (e.g. an admin publishing 20 Exercise questions one at a time) —
// each publish upserts one row here instead of sending a push per question;
// the notification scheduler (jobs/notificationScheduler.js) picks up rows
// that have gone quiet for a couple of minutes and sends ONE grouped push.
const notificationQueueSchema = new mongoose.Schema(
  {
    key:        { type: String, required: true, unique: true, index: true }, // e.g. "exercise::<batchId>::<chapterId>"
    type:       { type: String, required: true }, // 'exercise'
    batchId:    { type: String, required: true },
    chapterId:  { type: String, default: '' },
    subjectId:  { type: String, default: '' },
    count:      { type: Number, default: 1 },
    notified:   { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

notificationQueueSchema.index({ notified: 1, updated_at: 1 });

module.exports = mongoose.model('NotificationQueue', notificationQueueSchema);
