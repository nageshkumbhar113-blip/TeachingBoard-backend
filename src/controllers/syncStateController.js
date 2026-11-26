/**
 * GET /api/student/sync-state — a tiny "has anything changed?" answer for the
 * student app's background sync, so it only downloads the (large) quiz and
 * question lists when they actually changed.
 *
 * Each fingerprint is a hash over exactly what decides that student's copy of
 * the matching full endpoint:
 *   quizzes   — mirrors GET /api/quizzes (student): every published quiz in the
 *               student's batches, by quiz_id + updated_at + version + batch/
 *               subject/chapter + locked/unlocked. Covers add, edit (createQuiz
 *               always bumps updated_at+version), delete, unpublish, batch
 *               rename (Quiz.updateMany only touches `batch`), and lock changes
 *               (free-chapter config, subscription expiry).
 *   questions — mirrors GET /api/questions (student): same filter, sort, 1000
 *               cap and free-chapter filtering, by q_id + updated_at.
 *   access    — full/free + expiry + assigned batches, so the app can force a
 *               full sync the moment a payment, expiry or class change alters
 *               what the student may see.
 * Results are memoised for 30 s per (batches, access level) — identical for
 * every student sharing them — so a whole class checking at once is one query.
 *
 * Kill switch: SYNC_STATE_DISABLED=1 answers { enabled:false } and the app falls
 * back to its old full-sync behaviour. SYNC_CHECK_SEC / SYNC_RESUME_SEC /
 * SYNC_FULL_SEC tune the app's timings without shipping a new app build.
 */
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const Quiz = require('../models/Quiz');
const Question = require('../models/Question');
const { getIndex: getQbankIndex } = require('./qbankController');
const { hasFullAccess, isQuizLocked, isChapterFree, freeWindowOver } = require('../utils/contentAccess');

const _memo = new Map(); // key -> { at, quizzes, questions }

const _num = (v, dflt) => (Number(v) > 0 ? Number(v) : dflt);
const MEMO_MS = _num(process.env.SYNC_STATE_MEMO_MS, 30_000);
const _hash = parts => crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
const _ts = d => (d ? new Date(d).getTime() : 0);

function _hints() {
  return {
    checkEverySec: _num(process.env.SYNC_CHECK_SEC, 600),
    resumeMinSec: _num(process.env.SYNC_RESUME_SEC, 120),
    fullEverySec: _num(process.env.SYNC_FULL_SEC, 3600),
  };
}

async function _quizzesFingerprint(userDoc, batches) {
  const quizzes = await Quiz.find({ status: 'published', batch: { $in: batches } })
    .select('quiz_id updated_at version batch subject chapter paper_mode sections.source_batch sections.subject sections.chapter')
    .lean();
  const parts = [];
  for (const q of quizzes) {
    const locked = await isQuizLocked(userDoc, q);
    parts.push(`${q.quiz_id}|${_ts(q.updated_at)}|${q.version}|${q.batch}|${q.subject}|${q.chapter}|${locked ? 'L' : 'U'}`);
  }
  parts.sort();
  return `${parts.length}:${_hash(parts)}`;
}

async function _questionsFingerprint(userDoc, batches) {
  let rows = await Question.find({ batch: { $in: batches } })
    .sort({ created_at: -1 }).limit(1000)
    .select('q_id updated_at batch subject chapter').lean();
  if (!hasFullAccess(userDoc)) {
    const kept = [];
    for (const r of rows) if (await isChapterFree(r.batch, r.subject, r.chapter, userDoc)) kept.push(r);
    rows = kept;
  }
  const parts = rows.map(r => `${r.q_id}|${_ts(r.updated_at)}`).sort();
  return `${parts.length}:${_hash(parts)}`;
}

exports.getSyncState = asyncHandler(async (req, res) => {
  if (process.env.SYNC_STATE_DISABLED === '1') {
    return res.json({ success: true, enabled: false });
  }
  const userDoc = req.userDoc || {};
  const batches = (Array.isArray(userDoc.assigned_batches) ? userDoc.assigned_batches : [])
    .map(b => String(b || '').trim()).filter(Boolean).sort();
  const full = hasFullAccess(userDoc);
  const over = !full && freeWindowOver(userDoc);   // free window ended → everything locked
  // Batches are part of `access` so assigning/removing a class (which also
  // changes the profile the app shows) forces a full sync including /auth/me.
  const access = `${full ? 'full' : over ? 'over' : 'free'}|${userDoc.expiry_date ? new Date(userDoc.expiry_date).toISOString().slice(0, 10) : ''}|${batches.join(',')}`;

  let fp = { quizzes: '0:', questions: '0:' };
  if (batches.length) {
    const key = `${batches.join(',')}|${full ? 'F' : over ? 'O' : 'R'}`;
    const hit = _memo.get(key);
    if (hit && Date.now() - hit.at < MEMO_MS) {
      fp = hit;
    } else {
      const [quizzes, questions] = await Promise.all([
        _quizzesFingerprint(userDoc, batches),
        _questionsFingerprint(userDoc, batches),
      ]);
      fp = { at: Date.now(), quizzes, questions };
      _memo.set(key, fp);
      if (_memo.size > 500) {
        for (const [k, v] of _memo) if (Date.now() - v.at > MEMO_MS) _memo.delete(k);
      }
    }
  }

  // the chapter-wise question bank (new apps): its index fingerprint (memoised in qbankController)
  const qbank = batches.length ? ((await getQbankIndex(userDoc).catch(() => null))?.fp || '') : '0:';

  res.json({
    success: true,
    enabled: true,
    quizzes: fp.quizzes,
    questions: fp.questions,
    qbank,
    access,
    ..._hints(),
  });
});

// GET /api/admin/sync-state — the Admin's own "has anything changed?" (Admin audit 2026-11-27). The Admin used to
// download every test (~20 MB), 1,000 questions and the lessons every 5 minutes and every time its browser tab was
// opened again; now it asks this first (~200 bytes) and downloads only the part whose fingerprint changed.
// Fingerprints: tests — quiz_id + updated_at + version + status + batch/subject/chapter (all statuses: the Admin
// sees drafts too); questions — q_id + updated_at; lessons — lesson_id + updated_at. Memoised 30 s.
// Kill switch: SYNC_STATE_DISABLED=1 → { enabled:false } (the Admin then downloads everything as before).
let _adminMemo = null;
exports.getAdminSyncState = asyncHandler(async (_req, res) => {
  if (process.env.SYNC_STATE_DISABLED === '1') return res.json({ success: true, enabled: false });
  if (!_adminMemo || Date.now() - _adminMemo.at > MEMO_MS) {
    const Lesson = require('../models/Lesson');
    const [qz, qs, ls] = await Promise.all([
      Quiz.find({}).select('quiz_id updated_at version status batch subject chapter').lean(),
      Question.find({}).select('q_id updated_at').lean(),
      Lesson.find({}).select('lesson_id updated_at').lean(),
    ]);
    const fp = (rows, line) => { const parts = rows.map(line).sort(); return `${parts.length}:${_hash(parts)}`; };
    _adminMemo = { at: Date.now(), body: {
      success: true, enabled: true,
      quizzes: fp(qz, q => `${q.quiz_id}|${_ts(q.updated_at)}|${q.version}|${q.status}|${q.batch}|${q.subject}|${q.chapter}`),
      questions: fp(qs, q => `${q.q_id}|${_ts(q.updated_at)}`),
      lessons: fp(ls, l => `${l.lesson_id}|${_ts(l.updated_at)}`),
      fullEverySec: _num(process.env.ADMIN_SYNC_FULL_SEC, 3 * 3600),
    } };
  }
  res.json(_adminMemo.body);
});
