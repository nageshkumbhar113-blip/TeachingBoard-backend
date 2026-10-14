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
 *   access    — full/free + expiry, so the app can force a full sync the moment
 *               a payment or expiry changes what the student may see.
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
const { hasFullAccess, isQuizLocked, isChapterFree } = require('../utils/contentAccess');

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
    for (const r of rows) if (await isChapterFree(r.batch, r.subject, r.chapter)) kept.push(r);
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
  const access = `${full ? 'full' : 'free'}|${userDoc.expiry_date ? new Date(userDoc.expiry_date).toISOString().slice(0, 10) : ''}`;

  let fp = { quizzes: '0:', questions: '0:' };
  if (batches.length) {
    const key = `${batches.join(',')}|${full ? 'F' : 'R'}`;
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

  res.json({
    success: true,
    enabled: true,
    quizzes: fp.quizzes,
    questions: fp.questions,
    access,
    ..._hints(),
  });
});
