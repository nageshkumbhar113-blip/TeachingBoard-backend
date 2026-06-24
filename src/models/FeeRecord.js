const { Schema, model } = require('mongoose');
const { randomUUID }    = require('crypto');

const paymentSchema = new Schema({
  amount:    { type: Number, required: true, min: 0 },
  paid_at:   { type: Date, default: () => new Date() },
  note:      { type: String, trim: true, default: '' },
  marked_by: { type: String, trim: true, default: '' },
}, { _id: false });

const feeRecordSchema = new Schema({
  fee_record_id: { type: String, required: true, unique: true, index: true, default: () => randomUUID() },
  fee_config_id: { type: String, required: true, index: true },
  student_code:  { type: String, required: true, trim: true },
  student_name:  { type: String, required: true, trim: true },
  batch:         { type: String, required: true, trim: true },
  total_amount:  { type: Number, required: true, min: 0 },
  paid_amount:   { type: Number, default: 0, min: 0 },
  status:        { type: String, enum: ['pending', 'partial', 'paid'], default: 'pending', index: true },
  payments:      { type: [paymentSchema], default: [] },
  notified_days: { type: [String], default: [] }, // ["2026-07-01"] — prevents duplicate daily sends
  created_at:    { type: Date, default: () => new Date() },
});

feeRecordSchema.index({ fee_config_id: 1, student_code: 1 }, { unique: true });
feeRecordSchema.index({ fee_config_id: 1, status: 1 });

module.exports = model('FeeRecord', feeRecordSchema);
