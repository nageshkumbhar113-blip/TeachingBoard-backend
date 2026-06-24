/* ═══════════════════════════════════════════════════════════════
   TestAssembler.js — Converts word bank into a generated question set.
   Word bank fetched ONCE. Emoji SVGs batched ONCE. Zero extra DB
   queries per question after initial load.
═══════════════════════════════════════════════════════════════ */

const { randomUUID }                        = require('crypto');
const Word                                  = require('../models/Word');
const EmojiCache                            = require('../models/EmojiCache');
const { QUESTION_TYPE_RULES, COLOR_POOL }   = require('./QuestionTypeRules');
const DistractorGenerator                   = require('./DistractorGenerator');

// ── Emoji helper (same as wordController) ────────────────────────
function _emojiToHexcode(emojiChar) {
  return [...emojiChar]
    .map(c => c.codePointAt(0).toString(16).toUpperCase())
    .join('-');
}

// ── Fisher-Yates shuffle ─────────────────────────────────────────
function _shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Convert word doc to a DistractorItem (for the correct option) ──
function _wordToItem(word, rule) {
  const base = {
    word_id:   word.word_id,
    text:      '',
    image_url: word.image_url || '',
    emoji:     word.emoji     || '',
    emoji_svg: word.emoji_svg || '',
    colour:    '',
  };

  switch (rule.answer_field) {
    case 'image_url':   base.text = word.word;        break;
    case 'meaning_mr':  base.text = word.meaning_mr;  break;
    case 'meaning_en':  base.text = word.meaning_en;  break;
    case 'word':
    default:            base.text = word.word;         break;
  }

  // Colour type: look up from COLOR_POOL by word text
  if (rule.option_type === 'colour') {
    const match = COLOR_POOL.find(c => c.text.toLowerCase() === word.word.toLowerCase());
    if (match) base.colour = match.colour;
  }

  return base;
}

// ── Build shuffled A/B/C/D options ───────────────────────────────
function _buildOptions(correctItem, distractorItems) {
  const allItems  = _shuffle([{ ...correctItem, _correct: true }, ...distractorItems]);
  const optionIds = ['A', 'B', 'C', 'D'];
  return allItems.slice(0, 4).map((item, idx) => ({
    id:        optionIds[idx],
    word_id:   item.word_id   || null,
    text:      item.text      || '',
    image_url: item.image_url || '',
    emoji:     item.emoji     || '',
    emoji_svg: item.emoji_svg || '',
    colour:    item.colour    || '',
    is_correct:!!item._correct,
  }));
}

// ── Main assemble function ────────────────────────────────────────

/**
 * Generate a question list from the word bank.
 *
 * @param {string} batch
 * @param {string} subject
 * @param {Array}  questionConfigs  - [{type: 'listen_spelling', count: 5}, ...]
 * @returns {object}  { questions, warnings }
 *   questions — array of WordTestQuestion-compatible objects
 *   warnings  — string[] describing any types that produced fewer Qs than requested
 */
async function assemble(batch, subject, questionConfigs) {
  // 1. Fetch entire word bank for this batch+subject ONCE
  const rawWords = await Word.find({ batch, subject }).sort({ seq_num: 1 }).lean();

  // 2. Batch-fetch all emoji SVGs needed by this word pool ONCE
  const emojiWords = rawWords.filter(w => w.emoji);
  const hexcodes   = [...new Set(emojiWords.map(w => _emojiToHexcode(w.emoji)))];
  const cached     = hexcodes.length
    ? await EmojiCache.find({ hexcode: { $in: hexcodes } }).lean()
    : [];
  const svgMap = Object.fromEntries(cached.map(e => [e.hexcode, e.svg]));

  // 3. Attach emoji_svg to word objects (in-memory enrichment)
  const wordPool = rawWords.map(w => {
    if (w.emoji) {
      const hex = _emojiToHexcode(w.emoji);
      return { ...w, emoji_svg: svgMap[hex] || '' };
    }
    return { ...w, emoji_svg: '' };
  });

  const usedWordIds = new Set();
  const questions   = [];
  const warnings    = [];

  // 4. Process each question type config in order
  for (const config of questionConfigs) {
    const rule = QUESTION_TYPE_RULES[config.type];
    if (!rule) {
      warnings.push(`Unknown question type: ${config.type}`);
      continue;
    }

    const requestedCount = Math.max(1, parseInt(config.count) || 1);

    // Filter eligible words for this type (not already used + required fields present)
    const eligible = wordPool.filter(w =>
      !usedWordIds.has(w.word_id) &&
      rule.requires_fields.every(f => w[f] && String(w[f]).trim() !== '') &&
      (!rule.requires_category || w.word_category === rule.requires_category)
    );

    // typing type: no distractors needed, just 1 word per question
    // all others: need distractor pool to be large enough
    const canGenerate = rule.option_type === 'typing'
      ? eligible.length >= 1
      : eligible.length >= rule.min_pool_size;

    if (!canGenerate) {
      warnings.push(
        `${rule.label}: not enough eligible words ` +
        `(need ${rule.min_pool_size}, found ${eligible.length}). Skipped.`
      );
      continue;
    }

    const toUse = _shuffle([...eligible]).slice(0, requestedCount);

    if (toUse.length < requestedCount) {
      warnings.push(
        `${rule.label}: requested ${requestedCount}, could only generate ${toUse.length}.`
      );
    }

    for (const word of toUse) {
      usedWordIds.add(word.word_id);

      let options   = [];
      let correctId = null;

      if (rule.option_type === 'typing') {
        // Store actual word server-side for case-insensitive comparison on submit
        correctId = word.word;
      } else {
        const distractors  = DistractorGenerator.generate(rule.distractor_strategy, word, wordPool);
        const correctItem  = _wordToItem(word, rule);
        options            = _buildOptions(correctItem, distractors);
        const correctOpt   = options.find(o => o.is_correct);
        correctId          = correctOpt ? correctOpt.id : null;
      }

      questions.push({
        question_id:       randomUUID(),
        word_id:           word.word_id,
        type:              config.type,
        option_type:       rule.option_type,
        audio:             rule.audio,
        audio_word:        word.word,
        question_label:    rule.label,
        question_label_mr: rule.label_mr,
        question_template: rule.question_template,
        options,
        correct_id:        correctId,
        seq_num:           questions.length + 1,
      });
    }
  }

  return { questions, warnings };
}

module.exports = { assemble };
