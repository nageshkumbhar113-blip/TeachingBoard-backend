/**
 * Question bank, one chapter at a time (owner 2026-11-22).
 *
 * GET /api/student/qbank/index    — every chapter of the student's bank that they may open,
 *                                   with its question count and a version (count + last change).
 * GET /api/student/qbank/chapter  — all questions of one chapter (?batch=&subject=&chapter=).
 *
 * The old GET /api/questions sends only the newest 1000 questions of all the student's
 * classes together; a class can have 20,000+. The app now keeps the index, downloads the
 * chapter a child opens at once, and the rest quietly one at a time; afterwards only a
 * chapter whose version changed is downloaded again. Old app versions keep using
 * GET /api/questions, which is unchanged.
 *
 * The index is the same for every student with the same classes and access, so it is
 * memoised for INDEX_MEMO_MS (default 60 s): a whole class asking at once is one query.
 * Its fingerprint is also sent in /api/student/sync-state as `qbank`.
 */
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const Question = require('../models/Question');
const { hasFullAccess, isChapterFree, freeWindowOver } = require('../utils/contentAccess');

const _num = (v, dflt) => (Number(v) > 0 ? Number(v) : dflt);
const INDEX_MEMO_MS = _num(process.env.QBANK_INDEX_MEMO_MS, 60_000);
const _memo = new Map();   // key -> { at, chapters, fp, pending }

const _batchesOf = userDoc => (Array.isArray(userDoc?.assigned_batches) ? userDoc.assigned_batches : [])
  .map(b => String(b || '').trim()).filter(Boolean).sort();

function _accessKey(userDoc) {
  const full = hasFullAccess(userDoc);
  return full ? 'F' : freeWindowOver(userDoc) ? 'O' : 'R';
}

async function _buildIndex(userDoc, batches) {
  const rows = await Question.aggregate([
    { $match: { batch: { $in: batches } } },
    { $group: { _id: { b: '$batch', s: '$subject', c: '$chapter' }, n: { $sum: 1 }, u: { $max: '$updated_at' } } },
  ]);
  const full = hasFullAccess(userDoc);
  const chapters = [];
  for (const r of rows) {
    const { b, s, c } = r._id;
    if (!b || !c) continue;
    if (!full && !(await isChapterFree(b, s, c, userDoc))) continue;
    chapters.push({ b, s: s || '', c, n: r.n, v: `${r.n}:${r.u ? new Date(r.u).getTime() : 0}` });
  }
  chapters.sort((x, y) => (x.b + x.s + x.c).localeCompare(y.b + y.s + y.c));
  const fp = `${chapters.length}:${crypto.createHash('sha1').update(chapters.map(x => `${x.b}|${x.s}|${x.c}|${x.v}`).join('\n')).digest('hex').slice(0, 16)}`;
  return { chapters, fp };
}

// one computation per (classes, access) at a time; reused for INDEX_MEMO_MS
async function getIndex(userDoc) {
  const batches = _batchesOf(userDoc);
  if (!batches.length) return { chapters: [], fp: '0:' };
  const key = `${batches.join(',')}|${_accessKey(userDoc)}`;
  const hit = _memo.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < INDEX_MEMO_MS)) return hit.pending || hit;
  const pending = _buildIndex(userDoc, batches)
    .then(v => { _memo.set(key, { at: Date.now(), ...v }); return v; })
    .catch(err => { _memo.delete(key); throw err; });
  _memo.set(key, { at: 0, pending });
  if (_memo.size > 500) for (const [k, v] of _memo) if (!v.pending && Date.now() - v.at > INDEX_MEMO_MS) _memo.delete(k);
  return pending;
}

exports.getIndex = getIndex;

exports.getQbankIndex = asyncHandler(async (req, res) => {
  const idx = await getIndex(req.userDoc || {});
  res.json({ success: true, fp: idx.fp, chapters: idx.chapters });
});

exports.getQbankChapter = asyncHandler(async (req, res) => {
  const userDoc = req.userDoc || {};
  const batch = String(req.query.batch || '').trim();
  const subject = String(req.query.subject || '').trim();
  const chapter = String(req.query.chapter || '').trim();
  if (!batch || !chapter) throw new AppError('batch and chapter are required', 400);
  if (!_batchesOf(userDoc).includes(batch)) throw new AppError('This class is not assigned to your account', 403);
  if (!hasFullAccess(userDoc) && !(await isChapterFree(batch, subject, chapter, userDoc))) {
    return res.status(403).json({ success: false, code: 'CHAPTER_LOCKED', message: 'हा धडा Course घेतल्यावर उघडेल' });
  }
  const rows = await Question.find({ batch, subject, chapter }).lean();
  const last = rows.reduce((m, r) => Math.max(m, r.updated_at ? new Date(r.updated_at).getTime() : 0), 0);
  res.json({ success: true, v: `${rows.length}:${last}`, count: rows.length, data: rows });
});
