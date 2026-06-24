/* ═══════════════════════════════════════════════════════════════
   WordBankStats.js — Pre-generate stats for a batch+subject word bank.
   Admin sees these stats before creating a test so they know which
   question types are feasible and how many questions are possible.
═══════════════════════════════════════════════════════════════ */

const Word                    = require('../models/Word');
const { QUESTION_TYPE_RULES } = require('./QuestionTypeRules');

/**
 * @param {string} batch
 * @param {string} subject
 * @returns {object} stats
 */
async function getStats(batch, subject) {
  const words = await Word.find({ batch, subject }).lean();
  const total = words.length;

  const withImage     = words.filter(w => w.image_url && w.image_url.trim()).length;
  const withEmoji     = words.filter(w => w.emoji     && w.emoji.trim()).length;
  const withMeaningMr = words.filter(w => w.meaning_mr && w.meaning_mr.trim()).length;
  const withMeaningEn = words.filter(w => w.meaning_en && w.meaning_en.trim()).length;

  // Per-type feasibility
  const typeStats = {};
  for (const [type, rule] of Object.entries(QUESTION_TYPE_RULES)) {
    const eligible = words.filter(w =>
      rule.requires_fields.every(f => w[f] && String(w[f]).trim() !== '') &&
      (!rule.requires_category || w.word_category === rule.requires_category)
    ).length;

    typeStats[type] = {
      label:         rule.label,
      label_mr:      rule.label_mr,
      option_type:   rule.option_type,
      eligible,
      max_questions: eligible,
      feasible:      eligible >= rule.min_pool_size,
      min_required:  rule.min_pool_size,
    };
  }

  // Words missing any useful data (no meaning AND no image AND no emoji)
  const missingAll = words.filter(
    w => !w.meaning_mr && !w.meaning_en && !w.image_url && !w.emoji
  ).map(w => ({ word_id: w.word_id, word: w.word }));

  return {
    batch,
    subject,
    total,
    with_image:      withImage,
    with_emoji:      withEmoji,
    with_meaning_mr: withMeaningMr,
    with_meaning_en: withMeaningEn,
    type_stats:      typeStats,
    missing_enrichment_count: missingAll.length,
    missing_enrichment_words: missingAll.slice(0, 20), // max 20 shown to admin
  };
}

module.exports = { getStats };
