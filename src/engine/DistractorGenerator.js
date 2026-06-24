/* ═══════════════════════════════════════════════════════════════
   DistractorGenerator.js — Generates wrong options for word-test questions.
   All strategies work on the in-memory wordPool (no extra DB queries).
   Returns DistractorItem[]: { word_id, text, image_url, emoji, emoji_svg, colour }
═══════════════════════════════════════════════════════════════ */

const { COLOR_POOL, ALPHABET_POOL, NUMBER_POOL } = require('./QuestionTypeRules');

// ── Keyboard layout for realistic spelling mistakes ───────────────
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

// Build neighbor map: char → [adjacent chars in same row]
const _KEYBOARD_NEIGHBORS = {};
for (const row of KEYBOARD_ROWS) {
  for (let i = 0; i < row.length; i++) {
    const neighbors = [];
    if (i > 0)              neighbors.push(row[i - 1]);
    if (i < row.length - 1) neighbors.push(row[i + 1]);
    _KEYBOARD_NEIGHBORS[row[i]] = neighbors;
  }
}

// ── Fisher-Yates shuffle (returns new array) ─────────────────────
function _shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Wrong Spelling Generator ─────────────────────────────────────
// Produces plausible misspellings using 4 algorithms.
// All operations on lowercase, returned in original word's case.
function _generateWrongSpellings(word, count = 3) {
  const w    = word.toLowerCase();
  const seen = new Set([w]);
  const candidates = [];

  // Algorithm 1: SWAP — swap first pair of adjacent different chars
  for (let i = 0; i < w.length - 1; i++) {
    if (w[i] !== w[i + 1]) {
      const a = w.split('');
      [a[i], a[i + 1]] = [a[i + 1], a[i]];
      const s = a.join('');
      if (!seen.has(s)) { seen.add(s); candidates.push(s); }
      break;
    }
  }

  // Algorithm 2: DELETE — remove middle char (looks like typo omission)
  if (w.length > 2) {
    const mid = Math.floor(w.length / 2);
    const s   = w.slice(0, mid) + w.slice(mid + 1);
    if (!seen.has(s) && s.length >= 2) { seen.add(s); candidates.push(s); }
  }

  // Algorithm 3: DOUBLE — duplicate a char early in the word
  if (w.length >= 2) {
    const dbl = Math.max(0, Math.floor(w.length / 3));
    const s   = w.slice(0, dbl + 1) + w[dbl] + w.slice(dbl + 1);
    if (!seen.has(s)) { seen.add(s); candidates.push(s); }
  }

  // Algorithm 4: REPLACE — swap a char with its keyboard neighbor
  // Work from near-end of word to avoid changing the first char
  for (let i = w.length - 2; i >= 0; i--) {
    const neighbors = _KEYBOARD_NEIGHBORS[w[i]];
    if (neighbors && neighbors.length > 0) {
      const neighbor = neighbors[0];
      const s = w.slice(0, i) + neighbor + w.slice(i + 1);
      if (!seen.has(s)) { seen.add(s); candidates.push(s); break; }
    }
  }

  // Validate: all alpha, length within ±2 of original
  const valid = candidates.filter(s =>
    /^[a-z]+$/.test(s) &&
    Math.abs(s.length - w.length) <= 2
  );

  // Return in same case as original (preserve first-char capitalisation)
  const isTitle = word[0] === word[0].toUpperCase() && word.slice(1) === word.slice(1).toLowerCase();
  const isUpper = word === word.toUpperCase() && word.length > 1;

  return valid.slice(0, count).map(s => {
    if (isUpper) return s.toUpperCase();
    if (isTitle) return s[0].toUpperCase() + s.slice(1);
    return s;
  });
}

// ── DistractorItem factory ───────────────────────────────────────
function _item(overrides) {
  return {
    word_id:   null,
    text:      '',
    image_url: '',
    emoji:     '',
    emoji_svg: '',
    colour:    '',
    ...overrides,
  };
}

// ── Strategy implementations ─────────────────────────────────────

function _sameSubjectImages(correctWordId, wordPool) {
  return _shuffle(
    wordPool.filter(w => w.word_id !== correctWordId && w.image_url)
  )
  .slice(0, 3)
  .map(w => _item({ word_id: w.word_id, text: w.word, image_url: w.image_url,
                     emoji: w.emoji || '', emoji_svg: w.emoji_svg || '' }));
}

function _sameSubjectWords(correctWordId, wordPool) {
  return _shuffle(
    wordPool.filter(w => w.word_id !== correctWordId)
  )
  .slice(0, 3)
  .map(w => _item({ word_id: w.word_id, text: w.word }));
}

function _sameSubjectMeaningsMr(correctWordId, wordPool) {
  return _shuffle(
    wordPool.filter(w => w.word_id !== correctWordId && w.meaning_mr)
  )
  .slice(0, 3)
  .map(w => _item({ word_id: w.word_id, text: w.meaning_mr }));
}

function _sameSubjectMeaningsEn(correctWordId, wordPool) {
  return _shuffle(
    wordPool.filter(w => w.word_id !== correctWordId && w.meaning_en)
  )
  .slice(0, 3)
  .map(w => _item({ word_id: w.word_id, text: w.meaning_en }));
}

function _wrongSpellingGen(correctWord) {
  const spellings = _generateWrongSpellings(correctWord, 3);
  return spellings.map(s => _item({ text: s }));
}

function _fixedColorPool(correctText) {
  return _shuffle(
    COLOR_POOL.filter(c => c.text.toLowerCase() !== correctText.toLowerCase())
  )
  .slice(0, 3)
  .map(c => _item({ text: c.text, colour: c.colour }));
}

function _fixedAlphabetPool(correctText) {
  return _shuffle(
    ALPHABET_POOL.filter(a => a.text.toLowerCase() !== correctText.toLowerCase())
  )
  .slice(0, 3)
  .map(a => _item({ text: a.text }));
}

function _fixedNumberPool(correctText) {
  return _shuffle(
    NUMBER_POOL.filter(n => n.text !== String(correctText))
  )
  .slice(0, 3)
  .map(n => _item({ text: n.text }));
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Generate distractors for a given strategy.
 * @param {string}   strategy   - key from QUESTION_TYPE_RULES.distractor_strategy
 * @param {object}   correctWord - lean Word document (already has emoji_svg attached if needed)
 * @param {object[]} wordPool    - all words in batch+subject (lean, emoji_svg pre-attached)
 * @returns {DistractorItem[]} up to 3 distractor items
 */
function generate(strategy, correctWord, wordPool) {
  switch (strategy) {
    case 'same_subject_images':      return _sameSubjectImages(correctWord.word_id, wordPool);
    case 'same_subject_words':       return _sameSubjectWords(correctWord.word_id, wordPool);
    case 'same_subject_meanings_mr': return _sameSubjectMeaningsMr(correctWord.word_id, wordPool);
    case 'same_subject_meanings_en': return _sameSubjectMeaningsEn(correctWord.word_id, wordPool);
    case 'wrong_spelling_gen':       return _wrongSpellingGen(correctWord.word);
    case 'fixed_color_pool':         return _fixedColorPool(correctWord.word);
    case 'fixed_alphabet_pool':      return _fixedAlphabetPool(correctWord.word);
    case 'fixed_number_pool':        return _fixedNumberPool(correctWord.word);
    default:                         return [];
  }
}

module.exports = { generate, _generateWrongSpellings };
