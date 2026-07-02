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
    // Questions are shared content — just unlink from batch rather than deleting
    Question.updateMany({ batch: name }, { $set: { batch: '' } }),
  ]);

  res.json({ success: true, message: 'Batch deleted' });
});

/**
 * PUT /api/batches/:name
 * Rename a batch and update all references atomically.
 * Body: { name: newName, icon? }
 */
exports.renameBatch = asyncHandler(async (req, res) => {
  const oldName = decodeURIComponent(req.params.name || '').trim();
  const newName = String(req.body.name || '').trim();
  const icon    = req.body.icon !== undefined ? String(req.body.icon).trim() : undefined;

  if (!oldName) throw new AppError('old name is required', 400);
  if (!newName) throw new AppError('new name is required', 400);

  if (oldName !== newName) {
    const conflict = await Batch.findOne({ name: newName });
    if (conflict) throw new AppError(`Batch "${newName}" already exists`, 409);
  }

  const updateFields = { name: newName };
  if (icon !== undefined) updateFields.icon = icon || '📚';

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
    ] : []),
  ]);

  const updated = await Batch.findOne({ name: newName }).lean();
  res.json({ success: true, data: { name: updated.name, icon: updated.icon } });
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

  await Batch.findOneAndUpdate(
    { name, 'subjects.name': subject },
    { $addToSet: { 'subjects.$.chapters': { name: chapter } } },
    { upsert: false }
  );
  res.json({ success: true });
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
  if (!batch) {
    throw new AppError(`Batch "${name}" not found`, 404);
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
    .select('name icon pricing_type monthly_price yearly_price trial_days description')
    .lean();

  const data = batches.map(b => ({
    name: b.name,
    icon: b.icon,
    pricing_type: b.pricing_type || 'paid',
    monthly_price: b.monthly_price || 0,
    yearly_price: b.yearly_price || 0,
    trial_days: b.trial_days != null ? b.trial_days : 1,
    description: b.description || '',
  }));

  res.json({ success: true, data });
});
