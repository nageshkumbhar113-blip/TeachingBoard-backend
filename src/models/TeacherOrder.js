const { mongoose } = require('../config/db');

/**
 * TeacherOrder — a teacher makes student accounts from the Teacher app (owner 2026-11-19): one course + plan,
 * a list of students, the price = the course price minus the सूट (discount) the admin set for this teacher
 * (none → full price). Paid online (Razorpay); only after the payment are the accounts made and joined to
 * the teacher. A student who already has this course running is only joined (not charged). The rows keep
 * each student's code and PIN (PIN = last 4 digits of the mobile, as in the admin import) for the PDF.
 */
const rowSchema = new mongoose.Schema({
  name:   { type: String, required: true, trim: true },
  mobile: { type: String, required: true, trim: true },
  school: { type: String, default: '', trim: true },
  action: { type: String, enum: ['create', 'update', 'join'], required: true },   // join = already has the course, not charged
  existing_id:  { type: String, default: '' },
  student_code: { type: String, default: '' },
  pin:    { type: String, default: '' },      // new students only (derived from the mobile)
  amount: { type: Number, default: 0 },
  status: { type: String, default: '' },      // after fulfilment: created | updated | joined | error
  error:  { type: String, default: '' },
}, { _id: false });

const teacherOrderSchema = new mongoose.Schema({
  order_no:        { type: String, required: true, unique: true },     // TO-xxxxxxxx
  teacher_user_id: { type: String, required: true, index: true },
  teacher_code:    { type: String, required: true, index: true },
  teacher_name:    { type: String, default: '' },
  batch:  { type: String, required: true },
  plan:   { type: String, enum: ['monthly', 'yearly'], required: true },
  expiry: { type: String, required: true },                           // IST day the new access runs to
  list_price:  { type: Number, required: true },                       // course price per student
  discount:    { type: Number, default: 0 },                           // सूट per student (₹)
  discount_rule: { type: String, default: '' },                        // e.g. "15%" or "₹200"
  unit_price:  { type: Number, required: true },                       // what the teacher pays per charged student
  charged:     { type: Number, default: 0 },                           // students charged
  amount:      { type: Number, required: true },                       // total ₹
  rows:   { type: [rowSchema], default: [] },
  razorpay_order_id:   { type: String, default: '', index: true },
  razorpay_payment_id: { type: String, default: '' },
  status: { type: String, enum: ['created', 'paid', 'done', 'failed'], default: 'created', index: true },
  paid_at: { type: Date, default: null },
  done_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false });

module.exports = mongoose.models.TeacherOrder || mongoose.model('TeacherOrder', teacherOrderSchema);
