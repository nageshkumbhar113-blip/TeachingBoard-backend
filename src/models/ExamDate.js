const { mongoose } = require('../config/db');

// Real exam dates an admin enters (unit test, सहामाही, बोर्ड…) so the free
// part can show an honest countdown ("📅 सहामाही: 23 दिवस"). batch '' = all.
const examDateSchema = new mongoose.Schema(
  {
    batch: { type: String, default: '', trim: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 60 },
    date:  { type: Date, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

module.exports = mongoose.models.ExamDate || mongoose.model('ExamDate', examDateSchema);
