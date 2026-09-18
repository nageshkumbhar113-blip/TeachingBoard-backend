const Batch = require('../models/Batch');
const Question = require('../models/Question');
const { isExpiredDate, normalizeExpiryDate } = require('./accountStatus');

// "Free chapter + paid" access rules.
//
// A student has FULL access unless they are on the free tier (self-registered
// and never paid) or their paid/admin-granted period has expired. Everyone
// else who is not a student (teacher, admin, parent, youtube_teacher) is never
// gated. Free-tier / expired students may only open FREE chapters: the first
// chapter (lowest `order`) of every subject, any chapter an admin flagged
// `is_free`, and every chapter of a batch whose pricing_type is 'free'.

// Byte-identical to youtubeTeacherController.makeChapterId (duplicated here so
// this util does not depend on a controller module).
function _norm(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function makeChapterId(batch, subject, chapter) {
  return `${_norm(batch)}::${_norm(subject)}::${_norm(chapter)}`;
}

const _CACHE_TTL = 60_000;
let _cache = null; // { at, freeChapterIds:Set, freeBatches:Set, freeList:[] }

async function _load() {
  const now = Date.now();
  if (_cache && now - _cache.at < _CACHE_TTL) return _cache;

  const [batches, derived] = await Promise.all([
    Batch.find({}, 'name pricing_type subjects').lean(),
    // Chapters that exist only through MCQ question data (never added to the
    // Batch catalog) still count: they follow the catalog chapters, A-Z.
    Question.aggregate([
      { $match: { batch: { $ne: '' }, subject: { $ne: '' }, chapter: { $ne: '' } } },
      { $group: { _id: { batch: '$batch', subject: '$subject', chapter: '$chapter' } } },
    ]),
  ]);

  const freeChapterIds = new Set();
  const freeBatches = new Set();
  const freeList = [];
  const addFree = (batch, subject, chapter) => {
    const id = makeChapterId(batch, subject, chapter);
    if (freeChapterIds.has(id)) return;
    freeChapterIds.add(id);
    freeList.push({ batch, subject, chapter, chapterId: id });
  };

  // subjects keyed by normalized batch|subject: { batch, subject, catalog:[{name,order,idx,is_free}], derived:Set }
  const subjects = new Map();
  const slot = (batch, subject) => {
    const key = `${_norm(batch)}|${_norm(subject)}`;
    if (!subjects.has(key)) subjects.set(key, { batch, subject, catalog: [], derived: new Map() });
    return subjects.get(key);
  };

  for (const b of batches) {
    if (b.pricing_type === 'free') freeBatches.add(_norm(b.name));
    for (const s of b.subjects || []) {
      const sl = slot(b.name, s.name);
      (s.chapters || []).forEach((c, i) => sl.catalog.push({ name: c.name, order: c.order || 0, idx: i, is_free: c.is_free === true }));
    }
  }
  for (const d of derived) {
    const { batch, subject, chapter } = d._id;
    const sl = slot(batch, subject);
    const known = sl.catalog.some(c => _norm(c.name) === _norm(chapter));
    if (!known) sl.derived.set(_norm(chapter), chapter);
  }

  for (const sl of subjects.values()) {
    sl.catalog.sort((a, z) => a.order - z.order || a.idx - z.idx);
    const derivedSorted = [...sl.derived.values()].sort((a, z) => a.localeCompare(z));
    const ordered = [
      ...sl.catalog.map(c => ({ name: c.name, is_free: c.is_free })),
      ...derivedSorted.map(name => ({ name, is_free: false })),
    ];
    ordered.forEach((c, idx) => {
      if (idx === 0 || c.is_free) addFree(sl.batch, sl.subject, c.name);
    });
  }

  _cache = { at: now, freeChapterIds, freeBatches, freeList };
  return _cache;
}

// [{ batch, subject, chapter, chapterId }] of every free chapter — used so the
// app can show the right lock icons.
async function listFreeChapters() {
  const c = await _load();
  return c.freeList;
}

function invalidateContentAccessCache() {
  _cache = null;
}

// Pure check on the (cached) user document — no DB access.
function hasFullAccess(userDoc) {
  if (!userDoc || userDoc.role !== 'student') return true;
  if (userDoc.free_tier === true) return false;
  const expiry = normalizeExpiryDate(userDoc.expiry_date);
  if (expiry && isExpiredDate(expiry)) return false;
  return true;
}

async function isChapterIdFree(chapterId) {
  const c = await _load();
  const id = String(chapterId || '');
  if (c.freeChapterIds.has(id)) return true;
  const batchPart = id.split('::')[0];
  return c.freeBatches.has(batchPart);
}

async function isChapterFree(batch, subject, chapter) {
  return isChapterIdFree(makeChapterId(batch, subject, chapter));
}

async function canAccessChapterId(userDoc, chapterId) {
  if (hasFullAccess(userDoc)) return true;
  return isChapterIdFree(chapterId);
}

async function canAccessChapter(userDoc, batch, subject, chapter) {
  if (hasFullAccess(userDoc)) return true;
  return isChapterFree(batch, subject, chapter);
}

// A quiz is locked for a free-tier / expired student unless it belongs to
// exactly one chapter and that chapter is free. Mixed quizzes (several
// chapters, or paper_mode 'mixed') are always locked.
async function isQuizLocked(userDoc, quiz) {
  if (hasFullAccess(userDoc)) return false;
  const src = typeof quiz.toObject === "function" ? quiz.toObject() : quiz;
  if (src.paper_mode === "mixed") return true;
  const refs = new Set([`${src.batch}|${src.subject}|${src.chapter}`]);
  for (const s of src.sections || []) {
    if (s.source_batch || s.subject || s.chapter) {
      refs.add(`${s.source_batch || src.batch}|${s.subject || src.subject}|${s.chapter || src.chapter}`);
    }
  }
  if (refs.size > 1) return true;
  return !(await isChapterFree(src.batch, src.subject, src.chapter));
}

// Standard 403 body for a locked item so the student app can show the
// "Subscribe" popup instead of a generic error.
function chapterLockedBody() {
  return {
    success: false,
    message: 'This chapter is locked. Subscribe to unlock all chapters.',
    code: 'CHAPTER_LOCKED',
  };
}

module.exports = {
  makeChapterId,
  hasFullAccess,
  isChapterFree,
  isChapterIdFree,
  listFreeChapters,
  canAccessChapter,
  canAccessChapterId,
  isQuizLocked,
  chapterLockedBody,
  invalidateContentAccessCache,
};
