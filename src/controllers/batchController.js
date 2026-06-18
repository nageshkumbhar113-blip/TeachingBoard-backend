const asyncHandler = require('../utils/asyncHandler');
const AppError     = require('../utils/AppError');
const Question     = require('../models/Question');
const Batch        = require('../models/Batch');

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
    });
  }

  // Merge question-derived data
  for (const row of rows) {
    const batchName = row._id;
    if (!batchName) continue;
    if (!map.has(batchName)) {
      map.set(batchName, { name: batchName, icon: '📚', subjects: [], chaptersFlat: [] });
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
  }));

  batches.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ success: true, data: batches });
});

/**
 * POST /api/batches
 * Create a new batch in the catalog.
 * Body: { name, icon? }
 */
exports.createBatch = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const icon = String(req.body.icon || '📚').trim() || '📚';
  if (!name) throw new AppError('name is required', 400);

  const batch = await Batch.findOneAndUpdate(
    { name },
    { $setOnInsert: { name, icon, subjects: [] } },
    { upsert: true, new: true }
  );
  res.status(201).json({ success: true, data: { name: batch.name, icon: batch.icon } });
});

/**
 * DELETE /api/batches/:name
 * Remove a batch from the catalog.
 */
exports.deleteBatch = asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name || '').trim();
  if (!name) throw new AppError('name is required', 400);
  await Batch.deleteOne({ name });
  res.json({ success: true, message: 'Batch deleted' });
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
