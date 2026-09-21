const { mongoose } = require('../config/db');

/**
 * CommissionEntry - one line of the partner (YouTube teacher / school teacher) ledger.
 *   type 'commission' : earned when a linked student's payment is verified (positive amount).
 *   type 'adjustment' : negative line created when a commission that is already inside a closed
 *                       monthly statement is reversed (refund / chargeback). It lands in the NEXT statement,
 *                       so a closed month never changes.
 * status 'active' | 'reversed' (reversed = cancelled before it was ever put in a statement).
 * A commission becomes payable at payable_at (payment date + hold days) and is counted in the
 * statement of the IST month that contains payable_at (see utils/partnerCommission.js).
 */
const commissionEntrySchema = new mongoose.Schema(
  {
    type:   { type: String, enum: ['commission', 'adjustment'], default: 'commission' },
    status: { type: String, enum: ['active', 'reversed'], default: 'active', index: true },

    partner_user_id: { type: String, required: true, index: true },
    partner_code:    { type: String, default: '' },

    student_code:    { type: String, default: '' },
    student_user_id: { type: String, default: '' },
    subscription_id: { type: String, default: '' },
    razorpay_payment_id: { type: String, unique: true, sparse: true },

    amount_paid: { type: Number, default: 0 },          // what the student paid (rupees)
    mode:        { type: String, default: 'flat' },     // flat | percent (snapshot)
    rate:        { type: Number, default: 0 },          // flat rupees, or percent (snapshot)
    amount:      { type: Number, required: true },      // commission in rupees (negative for adjustments)

    paid_at:    { type: Date, default: Date.now },      // when the student paid
    payable_at: { type: Date, required: true, index: true },
    payable_month: { type: String, default: '', index: true }, // 'YYYY-MM' (IST) of payable_at

    statement_id: { type: String, default: '', index: true },  // set once included in a statement
    ref_entry_id: { type: String, default: '' },               // for adjustments: the reversed entry
    note:         { type: String, default: '' },
    reversed_at:  { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

commissionEntrySchema.index({ partner_user_id: 1, statement_id: 1, status: 1 });
commissionEntrySchema.index({ partner_user_id: 1, student_code: 1, type: 1 });

module.exports = mongoose.models.CommissionEntry || mongoose.model('CommissionEntry', commissionEntrySchema);
