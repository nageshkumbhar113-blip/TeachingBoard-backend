const asyncHandler = require('../utils/asyncHandler');
const AppError     = require('../utils/AppError');
const Question           = require('../models/Question');
const Batch              = require('../models/Batch');
const User               = require('../models/User');
const Word               = require('../models/Word');
const WordTest           = require('../models/WordTest');
const VocabSubjectConfig = require('../models/VocabSubjectConfig');
const VocabAttempt       = require('../models/VocabAttempt');
const WordTestAttempt    = require('../models/WordTestAttempt');
const FeeConfig          = require('../models/FeeConfig');
const FeeRecord          = require('../models/FeeRecord');
const Note               = require('../models/Note');
const Lesson             = require('../models/Lesson');
const Quiz               = require('../models/Quiz');
const YoutubeTeacherVideo        = require('../models/YoutubeTeacherVideo');
const YoutubeTeacherTeachingArea = require('../models/YoutubeTeacherTeachingArea');
const SLSQuestion = require('../models/SLSQuestion');
const Concept      = require('../models/Concept');
// Same composite chapterId scheme as SLS concepts/exercises — reused here
// (not reimplemented) so a subject/chapter rename can correctly remap it.
const { makeChapterId } = require('./youtubeTeacherController');

/**
 * GET /api/batches
 * Returns batch→subject→chapter hierarchy merged from:
 *   1. Explicitly-created batch catalog (Batch model)
 *   2. Batches derived from question data
 */
exports.getBatches = asyncHandler(async (req, res) => {
  const [catalogDocs, rows] = await Promise.all([
    Batch.find().sort({ name: 1 }).lean(),
    Question.aggregate([
      { $match: { batch: { $exists: true, $ne: '' } } },
      {
        $group: {
          _id: { batch: '$batch', subject: '$subject', chapter: '$chapter' },
        },
      },
      {
        $group: {
          _id: '$_id.batch',
          subjects: {
            $addToSet: {
              $cond: [{ $ne: ['$_id.subject', ''] }, '$_id.subject', '$$REMOVE'],
            },
          },
          chapters: {
            $push: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$_id.subject', ''] },
                    { $ne: ['$_id.chapter', ''] },
                  ],
                },
                { subject: '$_id.subject', name: '$_id.chapter' },
                '$$REMOVE',
              ],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  // Build merged map: catalog wins for name/icon, questions fill in structure
  const map = new Map();

  // Seed from explicit catalog
  for (const doc of catalogDocs) {
    const subjects = (doc.subjects || []).map(s => ({
      name: s.name,
      chapters: (s.chapters || []).map(c => c.name || c),
    }));
    map.set(doc.name, {
      name: doc.name,
      icon: doc.icon || '📚',
      subjects,
      chaptersFlat: subjects.flatMap(s => s.chapters.map(ch => ({ subject: s.name, name: ch }))),
      // Pricing — so Classes and Pricing tabs share one batch list; a batch
      // with no pricing configured yet just reports 0/0 (shown as "Unpriced").
      monthly_price: doc.monthly_price || 0,
      yearly_price: doc.yearly_price || 0,
      trial_days: doc.trial_days != null ? doc.trial_days : 1,
    });
  }

  // Merge question-derived data
  for (const row of rows) {
    const batchName = row._id;
    if (!batchName) continue;
    if (!map.has(batchName)) {
      map.set(batchName, {
        name: batchName, icon: '📚', subjects: [], chaptersFlat: [],
        monthly_price: 0, yearly_price: 0, trial_days: 1,
      });
    }
    const entry = map.get(batchName);
    const existingSubjectNames = new Set(entry.subjects.map(s => s.name));

    for (const subjectName of (row.subjects || []).filter(Boolean)) {
      if (!existingSubjectNames.has(subjectName)) {
        entry.subjects.push({ name: subjectName, chapters: [] });
        existingSubjectNames.add(subjectName);
      }
      const subjectObj = entry.subjects.find(s => s.name === subjectName);
      const qChapters = (row.chapters || []).filter(c => c.subject === subjectName).map(c => c.name);
      const existingChapters = new Set(subjectObj.chapters);
      for (const ch of qChapters) {
        if (!existingChapters.has(ch)) {
          subjectObj.chapters.push(ch);
          existingChapters.add(ch);
        }
      }
    }
  }

  const batches = [...map.values()].map(b => ({
    name: b.name,
    icon: b.icon,
    subjects: b.subjects.map(s => s.name),
    chapters: b.subjects.flatMap(s => s.chapters.map(ch => ({ subject: s.name, name: ch }))),
    monthly_price: b.monthly_price || 0,
    yearly_price: b.yearly_price || 0,
    trial_days: b.trial_days != null ? b.trial_days : 1,
  }));

  batches.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ success: true, data: batches });
});

/**
 * POST /api/batches
 * Create a new batch in the catalog.
 * Body: { name, icon? }
 */
// Shared: validate subscription pricing input (monthly/yearly + trial).
// All batches are paid (Jio/Hotstar style); the only free access is the trial.
// Returns { pricing_type, monthly_price, yearly_price, trial_days }.
function buildPricingFields({ monthly_price, yearly_price, trial_days }) {
  const monthly = monthly_price === undefined ? 0 : Number(monthly_price);
  const yearly  = yearly_price  === undefined ? 0 : Number(yearly_price);
  const trial   = trial_days    === undefined ? 1 : Number(trial_days);

  if (!Number.isFinite(monthly) || monthly < 0) {
    throw new AppError('monthly_price must be a number >= 0', 400);
  }
  if (!Number.isFinite(yearly) || yearly < 0) {
    throw new AppError('yearly_price must be a number >= 0', 400);
  }
  if (monthly <= 0 && yearly <= 0) {
    throw new AppError('Set at least one of monthly_price or yearly_price', 400);
  }
  if (!Number.isFinite(trial) || trial < 0) {
    throw new AppError('trial_days must be a number >= 0', 400);
  }

  return {
    pricing_type: 'paid',
    monthly_price: Math.round(monthly * 100) / 100,
    yearly_price: Math.round(yearly * 100) / 100,
    trial_days: Math.floor(trial),
  };
}

exports.createBatch = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const icon = String(req.body.icon || '📚').trim() || '📚';
  if (!name) throw new AppError('name is required', 400);

  // Pricing is optional at creation; when monthly/yearly is provided, persist it.
  const hasPricing = req.body.monthly_price !== undefined || req.body.yearly_price !== undefined;
  const pricingFields = hasPricing ? buildPricingFields(req.body) : {};
  const description = req.body.description !== undefined ? String(req.body.description).trim() : undefined;

  const insertDoc = { name, icon, subjects: [], ...pricingFields };
  if (description !== undefined) insertDoc.description = description;

  const batch = await Batch.findOneAndUpdate(
    { name },
    { $setOnInsert: insertDoc },
    { upsert: true, new: true }
  );
  res.status(201).json({
    success: true,
    data: {
      name: batch.name,
      icon: batch.icon,
      pricing_type: batch.pricing_type,
      monthly_price: batch.monthly_price,
      yearly_price: batch.yearly_price,
      trial_days: batch.trial_days,
      description: batch.description,
    },
  });
});

/**
 * DELETE /api/batches/:name
 * Remove a batch and cascade-delete all related data:
 *   - Students' assigned_batches entry removed
 *   - Words, WordTests, VocabSubjectConfigs, VocabAttempts, WordTestAttempts deleted
 *   - FeeConfigs + their FeeRecords deleted
 *   - Notes and Lessons deleted
 *   - Questions batch field cleared (questions kept, just unlinked)
 */
exports.deleteBatch = asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name || '').trim();
  if (!name) throw new AppError('name is required', 400);

  // Find FeeConfig IDs for this batch so we can delete their FeeRecords
  const feeConfigs = await FeeConfig.find({ batch: name }, { fee_config_id: 1 }).lean();
  const feeConfigIds = feeConfigs.map(f => f.fee_config_id);

  await Promise.all([
    Batch.deleteOne({ name }),
    // Remove batch name from all students' assigned_batches arrays
    User.updateMany({ assigned_batches: name }, { $pull: { assigned_batches: name } }),
    // Delete batch-specific content
    Word.deleteMany({ batch: name }),
    WordTest.deleteMany({ batch: name }),
    VocabSubjectConfig.deleteMany({ batch: name }),
    VocabAttempt.deleteMany({ batch: name }),
    WordTestAttempt.deleteMany({ batch: name }),
    FeeConfig.deleteMany({ batch: name }),
    feeConfigIds.length ? FeeRecord.deleteMany({ fee_config_id: { $in: feeConfigIds } }) : Promise.resolve(),
    Note.deleteMany({ batch: name }),
    Lesson.deleteMany({ batch: name }),
    // Questions and Quizzes are shared content — just unlink from batch
    // rather than deleting. Quiz.batch was previously left untouched here,
    // which meant any quiz still tagged to the deleted batch would make
    // getBatches()'s question/quiz-derived aggregation resurrect a "ghost"
    // entry for it (and the admin app's local syncHierarchyFromExisting()
    // would do the same from its cached copy on next login).
    Question.updateMany({ batch: name }, { $set: { batch: '' } }),
    Quiz.updateMany({ batch: name }, { $set: { batch: '' } }),
  ]);

  res.json({ success: true, message: 'Batch deleted' });
});

/**
 * PUT /api/batches/:name
 * Rename a batch and update all references atomically.
 * Body: { name: newName, icon? }
 */
exports.renameBatch = asyncHandler(async (req, res) => {
  const oldName     = decodeURIComponent(req.params.name || '').trim();
  const newName     = String(req.body.name || '').trim();
  const icon        = req.body.icon !== undefined ? String(req.body.icon).trim() : undefined;
  const coverImage  = req.body.cover_image !== undefined ? String(req.body.cover_image).trim() : undefined;

  if (!oldName) throw new AppError('old name is required', 400);
  if (!newName) throw new AppError('new name is required', 400);

  if (oldName !== newName) {
    const conflict = await Batch.findOne({ name: newName });
    if (conflict) throw new AppError(`Batch "${newName}" already exists`, 409);
  }

  // Capture the batch's current subject/chapter structure BEFORE renaming —
  // needed to remap Concept/SLSQuestion chapterId below. Real bug found
  // live: chapterId embeds the batch name (see makeChapterId), and this
  // rename never remapped it — every existing Note/Exercise under a
  // renamed batch silently orphaned under the old chapterId even though
  // this cascade updated everything else correctly.
  const batchDocBefore = oldName !== newName ? await Batch.findOne({ name: oldName }).lean() : null;

  const updateFields = { name: newName };
  if (icon !== undefined) updateFields.icon = icon || '📚';
  if (coverImage !== undefined) updateFields.cover_image = coverImage;

  await Promise.all([
    Batch.updateOne({ name: oldName }, { $set: updateFields }),
    // Update the batch name string in every collection that stores it
    ...(oldName !== newName ? [
      User.updateMany(
        { assigned_batches: oldName },
        { $set: { 'assigned_batches.$[el]': newName } },
        { arrayFilters: [{ el: oldName }] }
      ),
      Word.updateMany({ batch: oldName }, { $set: { batch: newName } }),
      WordTest.updateMany({ batch: oldName }, { $set: { batch: newName } }),
      VocabSubjectConfig.updateMany({ batch: oldName }, { $set: { batch: newName } }),
      VocabAttempt.updateMany({ batch: oldName }, { $set: { batch: newName } }),
      WordTestAttempt.updateMany({ batch: oldName }, { $set: { batch: newName } }),
      FeeConfig.updateMany({ batch: oldName }, { $set: { batch: newName } }),
      Note.updateMany({ batch: oldName }, { $set: { batch: newName } }),
      Lesson.updateMany({ batch: oldName }, { $set: { batch: newName } }),
      Question.updateMany({ batch: oldName }, { $set: { batch: newName } }),
      YoutubeTeacherVideo.updateMany({ batch_name: oldName }, { $set: { batch_name: newName } }),
      YoutubeTeacherTeachingArea.updateMany({ batch_name: oldName }, { $set: { batch_name: newName } }),
      ..._remapChapterIdsForBatch(oldName, newName, batchDocBefore),
    ] : []),
  ]);

  const updated = await Batch.findOne({ name: newName }).lean();
  res.json({ success: true, data: { name: updated.name, icon: updated.icon } });
});

// Concept/SLSQuestion chapterId embeds the batch name — a batch rename must
// remap it for every existing subject+chapter, same technique as
// renameSubject/renameChapter below. Returns an array of promises (spread
// into the Promise.all above), not a single promise.
function _remapChapterIdsForBatch(oldBatchName, newBatchName, batchDoc) {
  const promises = [];
  for (const subjectDoc of (batchDoc?.subjects || [])) {
    for (const ch of (subjectDoc.chapters || [])) {
      const oldChapterId = makeChapterId(oldBatchName, subjectDoc.name, ch.name);
      const newChapterId = makeChapterId(newBatchName, subjectDoc.name, ch.name);
      promises.push(
        SLSQuestion.updateMany({ chapterId: oldChapterId }, { $set: { chapterId: newChapterId } }),
        Concept.updateMany({ chapterId: oldChapterId }, { $set: { chapterId: newChapterId } })
      );
    }
  }
  return promises;
}

// GET /api/batches/orphaned-chapter-ids
// Diagnostic companion to repair-chapter-ids below — finds every distinct
// chapterId batch-prefix used by an existing Concept/SLSQuestion that does
// NOT match any batch name in the current catalog, so a stale/orphaned
// prefix (from a rename before the chapterId cascade fix existed) can be
// found without having to already know/guess the old batch name.
exports.listOrphanedChapterIds = asyncHandler(async (_req, res) => {
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
  const [allBatches, conceptCounts, questionCounts] = await Promise.all([
    Batch.find({}, 'name').lean(),
    Concept.aggregate([{ $group: { _id: { $arrayElemAt: [{ $split: ['$chapterId', '::'] }, 0] }, count: { $sum: 1 } } }]),
    SLSQuestion.aggregate([{ $group: { _id: { $arrayElemAt: [{ $split: ['$chapterId', '::'] }, 0] }, count: { $sum: 1 } } }]),
  ]);
  const validPrefixes = new Set(allBatches.map(b => norm(b.name)));

  const orphaned = new Map(); // prefix -> { concepts, questions }
  const get = prefix => {
    if (!orphaned.has(prefix)) orphaned.set(prefix, { concepts: 0, questions: 0 });
    return orphaned.get(prefix);
  };
  conceptCounts.forEach(row => { if (!validPrefixes.has(row._id)) get(row._id).concepts = row.count; });
  questionCounts.forEach(row => { if (!validPrefixes.has(row._id)) get(row._id).questions = row.count; });

  res.json({ success: true, orphaned: [...orphaned.entries()].map(([prefix, counts]) => ({ batch_prefix: prefix, ...counts })) });
});

// POST /api/batches/:name/repair-chapter-ids
// Body: { old_batch_name }
// One-time repair utility for batches renamed BEFORE the chapterId-cascade
// fix above existed (or any other historical mismatch) — finds every
// Concept/SLSQuestion whose chapterId still starts with the OLD batch's
// normalized prefix and rewrites that prefix to the CURRENT batch name,
// recovering content that got silently orphaned. Works regardless of
// whether the affected chapter still exists in the Batch catalog today
// (unlike the cascade above, which only knows about chapters present at
// rename time) — a prefix rewrite, not a per-chapter lookup. Safe to
// re-run: a no-op once nothing matches the old prefix anymore.
exports.repairBatchChapterIds = asyncHandler(async (req, res) => {
  const currentName = decodeURIComponent(req.params.name || '').trim();
  const oldName = String(req.body.old_batch_name || '').trim();
  if (!currentName) throw new AppError('batch name is required', 400);
  if (!oldName) throw new AppError('old_batch_name is required', 400);

  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
  const oldPrefix = `${norm(oldName)}::`;
  const newPrefix = `${norm(currentName)}::`;
  if (oldPrefix === newPrefix) {
    return res.json({ success: true, message: 'old_batch_name normalizes the same as the current name — nothing to repair', concepts_repaired: 0, questions_repaired: 0 });
  }

  const escaped = oldPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^' + escaped);

  const [concepts, questions] = await Promise.all([
    Concept.find({ chapterId: regex }, '_id chapterId').lean(),
    SLSQuestion.find({ chapterId: regex }, '_id chapterId').lean(),
  ]);
  const rewrite = id => newPrefix + id.slice(oldPrefix.length);

  await Promise.all([
    ...concepts.map(c => Concept.updateOne({ _id: c._id }, { $set: { chapterId: rewrite(c.chapterId) } })),
    ...questions.map(q => SLSQuestion.updateOne({ _id: q._id }, { $set: { chapterId: rewrite(q.chapterId) } })),
  ]);

  res.json({ success: true, concepts_repaired: concepts.length, questions_repaired: questions.length });
});

/**
 * POST /api/batches/:name/subjects
 * Add a subject to a batch.
 * Body: { subject }
 */
exports.addSubject = asyncHandler(async (req, res) => {
  const name    = decodeURIComponent(req.params.name || '').trim();
  const subject = String(req.body.subject || '').trim();
  if (!name)    throw new AppError('batch name is required', 400);
  if (!subject) throw new AppError('subject is required', 400);

  await Batch.findOneAndUpdate(
    { name },
    {
      $setOnInsert: { name, icon: '📚' },
      $addToSet: { subjects: { name: subject, chapters: [] } },
    },
    { upsert: true }
  );
  res.json({ success: true });
});

/**
 * PUT /api/batches/:name/subjects/:subject
 * Rename a subject. Body: { name: newSubjectName }
 * Cascades the subject-name string into every collection that stores it
 * (same convention as renameBatch above), and — because this subject's
 * chapters' chapterId (SLSQuestion/Concept) embeds the subject name —
 * remaps chapterId for every chapter under it too, so existing Notes/
 * Exercises don't get silently orphaned from the renamed subject.
 */
exports.renameSubject = asyncHandler(async (req, res) => {
  const batchName  = decodeURIComponent(req.params.name || '').trim();
  const oldSubject = decodeURIComponent(req.params.subject || '').trim();
  const newSubject = String(req.body.name || '').trim();
  if (!batchName || !oldSubject) throw new AppError('batch and subject are required', 400);
  if (!newSubject) throw new AppError('new name is required', 400);

  const batch = await Batch.findOne({ name: batchName, 'subjects.name': oldSubject });
  if (!batch) throw new AppError('Subject not found', 404);

  if (oldSubject !== newSubject && batch.subjects.some(s => s.name === newSubject)) {
    throw new AppError(`Subject "${newSubject}" already exists in this batch`, 409);
  }

  const subjectDoc = batch.subjects.find(s => s.name === oldSubject);
  const chapterNames = (subjectDoc.chapters || []).map(c => c.name);

  await Batch.updateOne(
    { name: batchName, 'subjects.name': oldSubject },
    { $set: { 'subjects.$.name': newSubject } }
  );

  if (oldSubject !== newSubject) {
    await Promise.all([
      Question.updateMany({ batch: batchName, subject: oldSubject }, { $set: { subject: newSubject } }),
      Note.updateMany({ batch: batchName, subject: oldSubject }, { $set: { subject: newSubject } }),
      Lesson.updateMany({ batch: batchName, subject: oldSubject }, { $set: { subject: newSubject } }),
      Word.updateMany({ batch: batchName, subject: oldSubject }, { $set: { subject: newSubject } }),
      WordTest.updateMany({ batch: batchName, subject: oldSubject }, { $set: { subject: newSubject } }),
      VocabSubjectConfig.updateMany({ batch: batchName, subject: oldSubject }, { $set: { subject: newSubject } }),
      VocabAttempt.updateMany({ batch: batchName, subject: oldSubject }, { $set: { subject: newSubject } }),
      WordTestAttempt.updateMany({ batch: batchName, subject: oldSubject }, { $set: { subject: newSubject } }),
      YoutubeTeacherVideo.updateMany({ batch_name: batchName, subject_name: oldSubject }, { $set: { subject_name: newSubject } }),
      YoutubeTeacherTeachingArea.updateMany({ batch_name: batchName, subject_name: oldSubject }, { $set: { subject_name: newSubject } }),
      ...chapterNames.map(chName => {
        const oldChapterId = makeChapterId(batchName, oldSubject, chName);
        const newChapterId = makeChapterId(batchName, newSubject, chName);
        return Promise.all([
          SLSQuestion.updateMany({ chapterId: oldChapterId }, { $set: { chapterId: newChapterId } }),
          Concept.updateMany({ chapterId: oldChapterId }, { $set: { chapterId: newChapterId } }),
        ]);
      }),
    ]);
  }

  res.json({ success: true });
});

/**
 * DELETE /api/batches/:name/subjects/:subject
 * Remove a subject (and its chapters) from a batch.
 */
exports.deleteSubject = asyncHandler(async (req, res) => {
  const name    = decodeURIComponent(req.params.name    || '').trim();
  const subject = decodeURIComponent(req.params.subject || '').trim();
  if (!name || !subject) throw new AppError('batch and subject are required', 400);

  await Batch.updateOne({ name }, { $pull: { subjects: { name: subject } } });
  res.json({ success: true });
});

/**
 * POST /api/batches/:name/subjects/:subject/chapters
 * Add a chapter to a subject.
 * Body: { chapter }
 */
exports.addChapter = asyncHandler(async (req, res) => {
  const name    = decodeURIComponent(req.params.name    || '').trim();
  const subject = decodeURIComponent(req.params.subject || '').trim();
  const chapter = String(req.body.chapter || '').trim();
  if (!name || !subject || !chapter) throw new AppError('batch, subject, and chapter are required', 400);

  const batch = await Batch.findOne({ name, 'subjects.name': subject });
  if (!batch) return res.json({ success: true });
  const subjectDoc = batch.subjects.find(s => s.name === subject);
  if (subjectDoc.chapters.some(c => c.name === chapter)) return res.json({ success: true });

  subjectDoc.chapters.push({ name: chapter, order: subjectDoc.chapters.length });
  await batch.save();
  res.json({ success: true });
});

/**
 * PUT /api/batches/:name/subjects/:subject/chapters/:chapter
 * Rename a chapter. Body: { name: newChapterName }
 * Cascades the chapter-name string, and remaps the composite chapterId
 * (SLSQuestion/Concept) so existing Notes/Exercises stay linked instead
 * of silently orphaning under the old name.
 */
exports.renameChapter = asyncHandler(async (req, res) => {
  const batchName  = decodeURIComponent(req.params.name || '').trim();
  const subject    = decodeURIComponent(req.params.subject || '').trim();
  const oldChapter = decodeURIComponent(req.params.chapter || '').trim();
  const newChapter = String(req.body.name || '').trim();
  if (!batchName || !subject || !oldChapter) throw new AppError('batch, subject and chapter are required', 400);
  if (!newChapter) throw new AppError('new name is required', 400);

  const batch = await Batch.findOne({ name: batchName, 'subjects.name': subject });
  if (!batch) throw new AppError('Subject not found', 404);
  const subjectDoc = batch.subjects.find(s => s.name === subject);
  if (!subjectDoc.chapters.some(c => c.name === oldChapter)) throw new AppError('Chapter not found', 404);

  if (oldChapter !== newChapter && subjectDoc.chapters.some(c => c.name === newChapter)) {
    throw new AppError(`Chapter "${newChapter}" already exists in this subject`, 409);
  }

  await Batch.updateOne(
    { name: batchName, 'subjects.name': subject },
    { $set: { 'subjects.$[s].chapters.$[c].name': newChapter } },
    { arrayFilters: [{ 's.name': subject }, { 'c.name': oldChapter }] }
  );

  if (oldChapter !== newChapter) {
    const oldChapterId = makeChapterId(batchName, subject, oldChapter);
    const newChapterId = makeChapterId(batchName, subject, newChapter);
    await Promise.all([
      Question.updateMany({ batch: batchName, subject, chapter: oldChapter }, { $set: { chapter: newChapter } }),
      Note.updateMany({ batch: batchName, subject, chapter: oldChapter }, { $set: { chapter: newChapter } }),
      YoutubeTeacherVideo.updateMany({ batch_name: batchName, subject_name: subject, chapter_name: oldChapter }, { $set: { chapter_name: newChapter } }),
      SLSQuestion.updateMany({ chapterId: oldChapterId }, { $set: { chapterId: newChapterId } }),
      Concept.updateMany({ chapterId: oldChapterId }, { $set: { chapterId: newChapterId } }),
    ]);
  }

  res.json({ success: true });
});

/**
 * PUT /api/batches/:name/subjects/:subject/chapters/reorder
 * Persist a new chapter display order.
 * Body: { order: [chapterName1, chapterName2, ...] }
 */
exports.reorderChapters = asyncHandler(async (req, res) => {
  const name    = decodeURIComponent(req.params.name    || '').trim();
  const subject = decodeURIComponent(req.params.subject || '').trim();
  const order   = Array.isArray(req.body.order) ? req.body.order : [];
  if (!name || !subject) throw new AppError('batch and subject are required', 400);
  if (!order.length) throw new AppError('order (array of chapter names) is required', 400);

  const batch = await Batch.findOne({ name, 'subjects.name': subject });
  if (!batch) return res.json({ success: true });
  const subjectDoc = batch.subjects.find(s => s.name === subject);

  order.forEach((chapterName, idx) => {
    const ch = subjectDoc.chapters.find(c => c.name === chapterName);
    if (ch) ch.order = idx;
  });
  await batch.save();
  res.json({ success: true });
});

/**
 * GET /api/batches/:name/subjects/:subject/chapters
 * Public — returns chapter names in display order, so any client
 * (including students, who never call the admin-only GET /batches)
 * can sort a locally-derived chapter list to match the admin's chosen order.
 */
exports.getSubjectChapters = asyncHandler(async (req, res) => {
  const name    = decodeURIComponent(req.params.name    || '').trim();
  const subject = decodeURIComponent(req.params.subject || '').trim();
  if (!name || !subject) throw new AppError('batch and subject are required', 400);

  const batch = await Batch.findOne({ name, 'subjects.name': subject }).lean();
  const subjectDoc = batch?.subjects.find(s => s.name === subject);
  const chapters = (subjectDoc?.chapters || [])
    .map(c => ({ name: c.name, order: c.order || 0 }))
    .sort((a, b) => a.order - b.order);

  res.json({ success: true, data: chapters });
});

/**
 * DELETE /api/batches/:name/subjects/:subject/chapters/:chapter
 * Remove a chapter from a subject.
 */
exports.deleteChapter = asyncHandler(async (req, res) => {
  const name    = decodeURIComponent(req.params.name    || '').trim();
  const subject = decodeURIComponent(req.params.subject || '').trim();
  const chapter = decodeURIComponent(req.params.chapter || '').trim();
  if (!name || !subject || !chapter) throw new AppError('batch, subject, and chapter are required', 400);

  await Batch.updateOne(
    { name, 'subjects.name': subject },
    { $pull: { 'subjects.$.chapters': { name: chapter } } }
  );
  res.json({ success: true });
});

/**
 * PUT /api/batches/:name/pricing
 * Update batch pricing (free/paid, base price, discount, discounted price)
 * Body: {
 *   pricing_type: 'free' | 'paid',
 *   base_price?: number,
 *   discount?: { type: 'fixed' | 'percentage', value: number },
 *   description?: string
 * }
 */
exports.updateBatchPricing = asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name || '').trim();
  if (!name) throw new AppError('batch name is required', 400);

  const updateData = buildPricingFields(req.body);

  if (req.body.description !== undefined) {
    updateData.description = String(req.body.description).trim();
  }

  // Upsert: a batch shown in the Pricing tab may only exist as a
  // question-derived "virtual" entry (no real Batch document yet, e.g.
  // "Live Server") — setting its price should create the document instead
  // of 404ing, since the whole point is "add pricing to Classes batches".
  const batch = await Batch.findOneAndUpdate(
    { name },
    { $set: updateData, $setOnInsert: { name, icon: '📚' } },
    { new: true, lean: true, upsert: true }
  );

  res.json({
    success: true,
    data: {
      name: batch.name,
      pricing_type: batch.pricing_type,
      monthly_price: batch.monthly_price,
      yearly_price: batch.yearly_price,
      trial_days: batch.trial_days,
      description: batch.description,
    },
  });
});

/**
 * GET /api/batches/:name/pricing
 * Get pricing details for a batch
 */
exports.getBatchPricing = asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name || '').trim();
  if (!name) throw new AppError('batch name is required', 400);

  const batch = await Batch.findOne({ name }).lean();

  // Batches derived only from Questions/Quizzes (no real Batch doc yet, e.g.
  // freshly used in a chapter but never priced) previously 404'd here,
  // which silently killed the admin's "Setup Pricing" button — the fetch
  // failed and the modal never opened. Return sane unpriced defaults
  // instead; submitting the form upserts the real Batch doc.
  if (!batch) {
    return res.json({
      success: true,
      data: {
        name,
        icon: '📚',
        pricing_type: 'paid',
        monthly_price: 0,
        yearly_price: 0,
        trial_days: 1,
        description: '',
        is_active: true,
      },
    });
  }

  res.json({
    success: true,
    data: {
      name: batch.name,
      icon: batch.icon,
      pricing_type: batch.pricing_type || 'paid',
      monthly_price: batch.monthly_price || 0,
      yearly_price: batch.yearly_price || 0,
      trial_days: batch.trial_days != null ? batch.trial_days : 1,
      description: batch.description || '',
      is_active: batch.is_active,
    },
  });
});

/**
 * GET /api/batches/pricing/all
 * Get pricing for all batches (for student view)
 */
exports.getAllBatchesPricing = asyncHandler(async (req, res) => {
  const batches = await Batch.find({ is_active: true })
    .select('name icon cover_image pricing_type monthly_price yearly_price trial_days description')
    .lean();

  const data = batches.map(b => ({
    name: b.name,
    icon: b.icon,
    cover_image: b.cover_image || '',
    pricing_type: b.pricing_type || 'paid',
    monthly_price: b.monthly_price || 0,
    yearly_price: b.yearly_price || 0,
    trial_days: b.trial_days != null ? b.trial_days : 1,
    description: b.description || '',
  }));

  res.json({ success: true, data });
});
