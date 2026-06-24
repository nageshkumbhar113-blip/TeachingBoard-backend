const { Schema, model } = require('mongoose');
const { randomUUID }    = require('crypto');

const feeConfigSchema = new Schema({
  fee_config_id: { type: String, required: true, unique: true, index: true, default: () => randomUUID() },
  batch:         { type: String, required: true, trim: true, index: true },
  fee_type:      { type: String, enum: ['tuition', 'exam', 'activity', 'other'], default: 'tuition' },
  label:         { type: String, required: true, trim: true },
  total_amount:  { type: Number, required: true, min: 1 },
  due_date:      { type: Date, required: true },
  status:        { type: String, enum: ['active', 'closed'], default: 'active', index: true },
  created_by:    { type: String, required: true, trim: true },
  created_at:    { type: Date, default: () => new Date() },
});

feeConfigSchema.index({ created_by: 1, status: 1 });
feeConfigSchema.index({ batch: 1, status: 1 });

module.exports = model('FeeConfig', feeConfigSchema);
