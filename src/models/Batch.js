const { mongoose } = require('../config/db');

const chapterSchema = new mongoose.Schema(
  {
    name:  { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
  },
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
    cover_image: { type: String, default: '', trim: true }, // 16:9 (1200x675) showcase image
    subjects: { type: [subjectSchema], default: [] },

    // Pricing
    pricing_type: { type: String, enum: ['free', 'paid'], default: 'paid' },

    // Subscription pricing (Jio/Hotstar style — student picks monthly or yearly)
    monthly_price: { type: Number, default: 0, min: 0 },
    yearly_price:  { type: Number, default: 0, min: 0 },
    // Free trial granted on first subscribe (days). 0 = no trial.
    trial_days:    { type: Number, default: 1, min: 0 },

    // Legacy single-price fields (kept for backward compatibility)
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
