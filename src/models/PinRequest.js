const { mongoose } = require('../config/db');

// "I forgot my code / PIN" when the help bot cannot confirm it on the phone
// itself (new phone, teacher, shop). The admin sees it in Admin > 🤖 Help and
// makes a new PIN in one click; `candidates` are the accounts on that number.
const pinRequestSchema = new mongoose.Schema(
  {
    role:    { type: String, enum: ['student', 'teacher', 'shop'], default: 'student' },
    name:    { type: String, default: '', trim: true },
    mobile:  { type: String, default: '', trim: true, index: true },
    code:    { type: String, default: '', trim: true },        // if they remember it
    note:    { type: String, default: '', trim: true },
    reason:  { type: String, default: '', trim: true },        // new_phone | not_matched | teacher | shop
    candidates: {
      type: [{ user_id: String, name: String, code: String, role: String, class: String, _id: false }],
      default: [],
    },
    status:  { type: String, enum: ['open', 'done', 'rejected'], default: 'open', index: true },
    done_for: { type: String, default: '' },                   // user_id that got the new PIN
    done_at:  { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

module.exports = mongoose.models.PinRequest || mongoose.model('PinRequest', pinRequestSchema);
