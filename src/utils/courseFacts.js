// What each course holds, for the course card's moving line (core/courseCard.js): subjects, chapters ("धडे"),
// chapters with Notes and the exercise answers per subject, free chapters and free tests. Counted from the real
// content (the same way Admin › Ads counts it for the videos), at most once an hour.
const Batch = require('../models/Batch');
const Note = require('../models/Note');
const SLSQuestion = require('../models/SLSQuestion');
const { listFreeChapters } = require('./contentAccess');

let _cache = null, _at = 0;
const HOUR = 60 * 60 * 1000;
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');

async function courseFacts() {
  if (_cache && Date.now() - _at < HOUR) return _cache;
  const [batches, notes, answers, free] = await Promise.all([
    Batch.find({ is_active: { $ne: false } }, 'name subjects.name subjects.chapters.name').lean(),
    // one row per chapter that has Notes
    Note.aggregate([{ $match: { status: { $ne: 'archived' } } }, { $group: { _id: { b: '$batch', s: '$subject', c: '$chapter' } } }]),
    SLSQuestion.aggregate([{ $match: { status: 'published' } }, { $group: { _id: { b: '$batchId', s: '$subjectId' }, n: { $sum: 1 } } }]),
    listFreeChapters().catch(() => []),
  ]);
  let freeTests = {};
  try { freeTests = await require('../controllers/guestController').freeTestCounts(); } catch { /* no counts */ }
  const out = {};
  for (const b of batches) {
    const subs = (b.subjects || []).map(s => {
      const noteChapters = notes.filter(r => r._id.b === b.name && norm(r._id.s) === norm(s.name)).length;
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
