// Board-style paper structure: sections (Q.1 (A), Q.2 (B) ...) with an "attempt any N"
// rule. Paper total = sum over sections of (attempt x marksEach), NOT the sum of every
// printed question, so "any two of three" never breaks the total.

const MAX_SECTIONS = 30;

function _str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

// Returns { sections, header, layout } cleaned for storage, or throws { message } via the callback.
// passageBlocks (optional): Map<blockId, totalMarks> for every PassageBlock the caller already
// loaded from the DB — a "passage" section carries the whole block as one unit instead of
// individual questions (see models/PassageBlock.js), so its marks come from the block, not
// from counting attempted questions.
function sanitizeStructure(body, questions, passageBlocks) {
  const layout = body.layout === 'board' ? 'board' : 'practice';
  if (layout !== 'board') return { layout: 'practice', sections: [], header: undefined, error: null };

  const blocks = passageBlocks instanceof Map ? passageBlocks : new Map();
  const rawSections = Array.isArray(body.sections) ? body.sections : [];
  if (!rawSections.length) return { error: 'A board-style paper needs at least one section' };
  if (rawSections.length > MAX_SECTIONS) return { error: `A paper can have at most ${MAX_SECTIONS} sections` };

  const seen = new Set();
  const sections = [];
  for (const s of rawSections) {
    const id = _str(s.id, 40);
    if (!id) return { error: 'Every section needs an id' };
    if (seen.has(id)) return { error: `Duplicate section id "${id}"` };
    seen.add(id);

    const passageBlockId = _str(s.passageBlockId, 40);
    if (passageBlockId) {
      if (!blocks.has(passageBlockId)) return { error: `Section ${_str(s.qNo, 8)}: passage block not found` };
      sections.push({
        id, qNo: _str(s.qNo, 8), part: _str(s.part, 4), instruction: _str(s.instruction, 400),
        passageBlockId, marksEach: blocks.get(passageBlockId), attempt: 1,
      });
      continue;
    }

    const marksEach = Number(s.marksEach);
    const attempt = Number(s.attempt);
    if (!(marksEach > 0)) return { error: `Section ${_str(s.qNo, 8)} needs marks per question above 0` };
    if (!Number.isInteger(attempt) || attempt < 1) return { error: `Section ${_str(s.qNo, 8)} needs an attempt count of at least 1` };
    sections.push({
      id,
      qNo: _str(s.qNo, 8),
      part: _str(s.part, 4),
      instruction: _str(s.instruction, 400),
      marksEach,
      attempt,
    });
  }

  // Every question must sit in a known, non-passage section, and each such section must have
  // enough questions. A passage section carries its block instead and takes no individual questions.
  const counts = new Map(sections.filter(s => !s.passageBlockId).map(s => [s.id, 0]));
  for (const q of questions) {
    if (!counts.has(q.sectionId)) return { error: 'Every question must be assigned to a section' };
    counts.set(q.sectionId, counts.get(q.sectionId) + 1);
  }
  for (const s of sections) {
    if (s.passageBlockId) continue;
    const n = counts.get(s.id);
    if (n < s.attempt) {
      return { error: `Section ${s.qNo}${s.part ? ` (${s.part})` : ''}: attempt ${s.attempt} but only ${n} question${n === 1 ? '' : 's'} added` };
    }
  }

  const h = body.header && typeof body.header === 'object' ? body.header : {};
  const header = {
    paperCode: _str(h.paperCode, 30),
    examLine: _str(h.examLine, 120),
    subjectLine: _str(h.subjectLine, 120),
    courseLine: _str(h.courseLine, 80),
    timeText: _str(h.timeText, 40),
    notes: (Array.isArray(h.notes) ? h.notes : []).map(n => _str(n, 300)).filter(Boolean).slice(0, 10),
    seatOnEveryPage: h.seatOnEveryPage !== false,
    mcqLayout: h.mcqLayout === 'columns' ? 'columns' : 'list',
  };

  return { layout, sections, header, error: null };
}

function boardTotalMarks(sections) {
  return sections.reduce((sum, s) => sum + s.attempt * s.marksEach, 0);
}

// MCQ-bank question -> the { questionText, answerText } shape the paper PDF already prints.
// Options go on their own lines: "(A) ...", "(B) ...".
function mcqSnapshot(q) {
  const options = {};
  for (const k of ['A', 'B', 'C', 'D']) options[k] = _str((q.options || {})[k], 300);
  return { qid: String(q._id), text: _str(q.question, 1500), options, answer: _str(q.answer, 8).toUpperCase() };
}

function mcqFormat(m) {
  const lines = ['A', 'B', 'C', 'D'].filter(k => m.options && m.options[k]).map(k => `(${k}) ${m.options[k]}`);
  const questionText = { english: [m.text, ...lines].join('\n') };
  const ans = m.answer && m.options && m.options[m.answer] ? `(${m.answer}) ${m.options[m.answer]}` : (m.answer || '');
  return { questionText, answerText: { english: ans } };
}

module.exports = { sanitizeStructure, boardTotalMarks, mcqSnapshot, mcqFormat };
