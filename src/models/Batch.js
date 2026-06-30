const { mongoose } = require('../config/db');

const chapterSchema = new mongoose.Schema(
  { name: { type: String, required: true, trim: true } },
  { _id: false }
);

const subjectSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    chapters: { type: [chapterSchema], default: [] },
  },
  { _id: false }
);

const discountSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['fixed', 'percentage'], required: true },
    value: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const batchSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, unique: true, trim: true },
    icon:     { type: String, default: '📚', trim: true },
    subjects: { type: [subjectSchema], default: [] },

    // Pricing
    pricing_type: { type: String, enum: ['free', 'paid'], default: 'paid' },

    // Paid Batch Fields
    base_price: { type: Number, default: 0, min: 0 },
    discount: { type: discountSchema, default: null },
    discounted_price: { type: Number, default: 0, min: 0 },

    // Status
    is_active: { type: Boolean, default: true },
    description: { type: String, default: '', trim: true },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

module.exports = mongoose.models.Batch || mongoose.model('Batch', batchSchema);
