// What each course holds, for the course card's moving line (core/courseCard.js): subjects, chapters ("धडे"),
// chapters with Notes and the exercise answers per subject, free chapters and free tests. Counted from the real
// content (the same way Admin › Ads counts it for the videos), at most once an hour.
const Batch = require('../models/Batch');
const Note = require('../models/Note');
const SLSQuestion = require('../models/SLSQuestion');
const Concept = require('../models/Concept');
const { listFreeChapters, makeChapterId } = require('./contentAccess');

let _cache = null, _at = 0;
const HOUR = 60 * 60 * 1000;
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');

async function courseFacts() {
  if (_cache && Date.now() - _at < HOUR) return _cache;
  const [batches, notes, answers, free, concepts] = await Promise.all([
    Batch.find({ is_active: { $ne: false } }, 'name subjects.name subjects.chapters.name').lean(),
    // one row per chapter that has Notes
    Note.aggregate([{ $match: { status: { $ne: 'archived' } } }, { $group: { _id: { b: '$batch', s: '$subject', c: '$chapter' } } }]),
    SLSQuestion.aggregate([{ $match: { status: 'published' } }, { $group: { _id: { b: '$batchId', s: '$subjectId' }, n: { $sum: 1 } } }]),
    listFreeChapters().catch(() => []),
    // the Notes screen's chapter notes (published concepts), one row per chapter
    Concept.aggregate([{ $match: { status: 'published' } }, { $group: { _id: '$chapterId' } }]),
  ]);
  const conceptChapters = new Set(concepts.map(r => r._id));
  let freeTests = {};
  try { freeTests = await require('../controllers/guestController').freeTestCounts(); } catch { /* no counts */ }
  const out = {};
  for (const b of batches) {
    const subs = (b.subjects || []).map(s => {
      // a chapter has Notes when it has published chapter notes (concepts) or an uploaded Notes file
      const fileCh = new Set(notes.filter(r => r._id.b === b.name && norm(r._id.s) === norm(s.name)).map(r => norm(r._id.c)));
      const noteChapters = (s.chapters || []).filter(c => conceptChapters.has(makeChapterId(b.name, s.name, c.name)) || fileCh.has(norm(c.name))).length;
      const ans = answers.filter(r => r._id.b === b.name && norm(r._id.s) === norm(s.name)).reduce((t, r) => t + r.n, 0);
      return { subject: s.name, chapters: (s.chapters || []).length, notes: noteChapters, answers: ans };
    });
    out[b.name] = {
      subjects: subs.length,
      chapters: subs.reduce((t, s) => t + s.chapters, 0),
      notes: subs.reduce((t, s) => t + s.notes, 0),
      answers: subs.reduce((t, s) => t + s.answers, 0),
      free_chapters: free.filter(f => f.batch === b.name).length,
      free_tests: freeTests[b.name] || 0,
      // the two subjects with the most Notes, and the two with the most answers (for "विज्ञान 1: 12 धड्यांच्या Notes")
      top_notes: subs.filter(s => s.notes).sort((x, y) => y.notes - x.notes).slice(0, 2).map(s => ({ subject: s.subject, n: s.notes })),
      top_answers: subs.filter(s => s.answers).sort((x, y) => y.answers - x.answers).slice(0, 2).map(s => ({ subject: s.subject, n: s.answers })),
    };
  }
  _cache = out; _at = Date.now();
  return out;
}

module.exports = { courseFacts };
