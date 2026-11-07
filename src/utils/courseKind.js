// A course's type: set in Admin (Batch.kind), else guessed from its name — the same rule as core/courseCard.js.
const EXAM_RX = /nmms|scholar|शिष्यवृत्ती|navodaya|नवोदय|olymp|ntse|\bmts\b|exam|परीक्षा|police|पोलीस|भरती|\btet\b|competitive|स्पर्धा/i;
function kindOf(b) {
  if (b && (b.kind === 'exam' || b.kind === 'regular')) return b.kind;
  return EXAM_RX.test(`${b?.name || ''} ${b?.standard || ''}`) ? 'exam' : 'regular';
}
const cleanKind = v => (v === 'exam' || v === 'regular' ? v : '');
module.exports = { kindOf, cleanKind };
