const { mongoose } = require('../config/db');

/**
 * PayoutStatement - the locked monthly account of one partner.
 * Closed on the 1st (IST) for the previous month; the admin pays it between the 2nd and the 5th.
 *   closed  : net >= minimum payout, waiting to be paid
 *   paid    : paid out (utr recorded)
 *   carried : net below the minimum (or negative), rolled into the next month's statement
 * A statement's numbers never change after it is created (later refunds become adjustments in the next one).
 */
const payoutStatementSchema = new mongoose.Schema(
  {
    partner_user_id: { type: String, required: true, index: true },
    partner_code:    { type: String, default: '' },
    partner_name:    { type: String, default: '' },
    month:           { type: String, required: true, index: true }, // 'YYYY-MM' (IST)

    new_count:   { type: Number, default: 0 },   // commission lines counted this month
    new_amount:  { type: Number, default: 0 },
    adjust_count:  { type: Number, default: 0 },
    adjust_amount: { type: Number, default: 0 }, // negative or 0
    carried_in:  { type: Number, default: 0 },
    net:         { type: Number, default: 0 },
    min_payout:  { type: Number, default: 0 },   // snapshot of the rule used

    status: { type: String, enum: ['closed', 'paid', 'carried'], default: 'closed', index: true },
    carried_to: { type: String, default: '' },   // month of the statement that absorbed it

    // Payout details snapshot + result
    upi_id:   { type: String, default: '' },
    upi_name: { type: String, default: '' },
    closed_at: { type: Date, default: Date.now },
    paid_at:   { type: Date, default: null },
    utr:       { type: String, default: '' },
    paid_by:   { type: String, default: '' },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

payoutStatementSchema.index({ partner_user_id: 1, month: 1 }, { unique: true });

module.exports = mongoose.models.PayoutStatement || mongoose.model('PayoutStatement', payoutStatementSchema);
