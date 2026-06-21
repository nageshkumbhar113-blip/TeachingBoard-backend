const { mongoose } = require('../config/db');

const notificationSchema = new mongoose.Schema(
  {
    notification_id: { type: String, required: true, unique: true, index: true, trim: true },
    sent_by:         { type: String, required: true, index: true, trim: true },
    sent_by_name:    { type: String, default: '' },
    type:            { type: String, enum: ['batch', 'individual'], required: true },
    batch:           { type: String, default: null, trim: true },
    student_code:    { type: String, default: null, trim: true, index: true },
    title:           { type: String, required: true, trim: true },
    body:            { type: String, required: true, trim: true },
    sent_at:         { type: Date, default: () => new Date(), index: true },
    recipient_count: { type: Number, default: 0 },
  },
  { collection: 'notifications', versionKey: false }
);

module.exports = mongoose.model('Notification', notificationSchema);
