const { mongoose } = require('../config/db');

const emojiCacheSchema = new mongoose.Schema(
  {
    hexcode: { type: String, required: true, unique: true, index: true },
    emoji:   { type: String, required: true },
    svg:     { type: String, required: true }, // base64 data URL: "data:image/svg+xml;base64,..."
  },
  { collection: 'emoji_cache', versionKey: false }
);

module.exports = mongoose.model('EmojiCache', emojiCacheSchema);
