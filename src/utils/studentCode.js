// Student code + PIN for admin-created / bulk-imported students (owner's rule, Nov 2026):
//   code = first 3 letters of the name + last 4 digits of the mobile   → "Manish Deshpande", 9856234589 → MAN4589
//   PIN  = last 4 digits of the mobile                                  → 4589
// Names written in Devanagari (मनीष) are transliterated first (→ MANISH → MAN4589).
// If the code is already taken by another student, a letter is added: MAN4589B, MAN4589C, …

const CONSONANTS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h', 'ळ': 'l',
  'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'फ़': 'f', 'ड़': 'd', 'ढ़': 'rh'
};
const VOWELS = { 'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ऋ': 'ru', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ॲ': 'a' };
const MATRAS = { 'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ru', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'a' };
const VIRAMA = '्';
const NUKTA = '़';

/** Devanagari → simple Latin (enough for a 3-letter code). Latin text is returned unchanged. */
function transliterate(text) {
  const chars = [...String(text || '').normalize('NFC')];
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    let ch = chars[i];
    if (chars[i + 1] === NUKTA) { ch += NUKTA; i += 1; }
    // ज्ञ is said "dny" in Marathi (ज्ञानेश्वर → Dnyaneshwar)
    if (ch === 'ज' && chars[i + 1] === VIRAMA && chars[i + 2] === 'ञ') { out += 'dny'; i += 2; ch = 'ञ'; }
    if (ch === 'ञ' && out.endsWith('dny')) {
      const next = chars[i + 1];
      if (MATRAS[next] !== undefined) { out += MATRAS[next]; i += 1; } else if (next && next !== VIRAMA) out += 'a';
      continue;
    }
    if (CONSONANTS[ch] !== undefined) {
      out += CONSONANTS[ch];
      const next = chars[i + 1];
      const nextIsLetter = next && (CONSONANTS[next] !== undefined || VOWELS[next] !== undefined);
      if (next === VIRAMA) { i += 1; continue; }
      if (MATRAS[next] !== undefined) { out += MATRAS[next]; i += 1; continue; }
      if (nextIsLetter) out += 'a'; // inherent vowel inside a word; dropped at the end of a word
      continue;
    }
    if (VOWELS[ch] !== undefined) { out += VOWELS[ch]; continue; }
    if (ch === 'ं' || ch === 'ँ') { out += 'n'; continue; }
    if (ch === 'ः') { out += 'h'; continue; }
    out += ch;
  }
  return out;
}

/** First 3 letters A–Z of the name (Devanagari transliterated); 'STU' when nothing usable. */
function namePrefix(name) {
  const latin = transliterate(name).toUpperCase().replace(/[^A-Z]/g, '');
  return (latin.slice(0, 3) || 'STU').padEnd(3, 'X');
}

function last4(mobile) {
  return String(mobile || '').replace(/\D/g, '').slice(-4);
}

/** Base code before de-duplication: MAN4589. */
function baseStudentCode(name, mobile) {
  return `${namePrefix(name)}${last4(mobile)}`;
}

/**
 * First free code for this student. `isTaken(code)` returns true when another student already
 * uses it (DB lookup and codes already given out in the same import).
 */
async function uniqueStudentCode(name, mobile, isTaken) {
  const base = baseStudentCode(name, mobile);
  if (!(await isTaken(base))) return base;
  for (const suffix of 'BCDEFGHJKLMNPQRSTUVWXYZ') {
    const code = `${base}${suffix}`;
    if (!(await isTaken(code))) return code;
  }
  throw new Error(`No free student code for ${base}`);
}

/** PIN = last 4 digits of the mobile. */
function pinFromMobile(mobile) {
  return last4(mobile);
}

module.exports = { transliterate, namePrefix, baseStudentCode, uniqueStudentCode, pinFromMobile };
