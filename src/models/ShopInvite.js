const { mongoose } = require('../config/db');

// A parent's number a shop sent the free-test link to (from its own WhatsApp,
// see shop.html). One row per shop + number; the shop panel matches it with
// guest leads / students to show how far that parent got.
const shopInviteSchema = new mongoose.Schema(
  {
    shop_code: { type: String, required: true, trim: true },
    mobile:    { type: String, required: true, trim: true },
    count:     { type: Number, default: 1 },
    last_at:   { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

shopInviteSchema.index({ shop_code: 1, mobile: 1 }, { unique: true });
shopInviteSchema.index({ shop_code: 1, last_at: -1 });

module.exports = mongoose.models.ShopInvite || mongoose.model('ShopInvite', shopInviteSchema);
