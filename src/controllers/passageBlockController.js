const { randomUUID } = require('crypto');
const PassageBlock = require('../models/PassageBlock');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { canAccessChapterId, chapterLockedBody, hasFullAccess, invalidateContentAccessCache } = require('../utils/contentAccess');

const TYPES = ['comprehension', 'poetry', 'nonverbal', 'writing'];
const FORMATS = ['fill_blanks', 'true_false', 'web_diagram', 'tree_diagram', 'match', 'short_answer', 'rearrange'];
const WRITING_FORMATS = ['', 'formal_letter', 'informal_letter', 'speech', 'story', 'news_report', 'essay', 'dialogue', 'ad', 'summary', 'information_transfer'];

// ── shared validation (used by both the single-create form and JSON import) ──

function _str(v, max) { return String(v ?? '').trim().slice(0, max); }

function validateBlock(raw, idx) {
  const at = `Block ${idx + 1}`;
  const type = _str(raw.type, 20);
  if (!TYPES.includes(type)) return { error: `${at}: type must be one of ${TYPES.join(', ')}` };
  const batchId = _str(raw.batchId, 200);
  const subjectId = _str(raw.subjectId, 200);
  if (!batchId) return { error: `${at}: batchId is required` };
  if (!subjectId) return { error: `${at}: subjectId is required` };
  const title = _str(raw.title, 200);
  if (!title) return { error: `${at}: title is required` };
  const language = ['english', 'marathi', 'hindi'].includes(raw.language) ? raw.language : 'english';
  const chapterId = _str(raw.chapterId, 300);

  const doc = {
    type, batchId, subjectId, chapterId, language, title,
    passage: '', passageImage: '', subQuestions: [],
    format: '', marks: 0, wordLimit: '', scenario: '', modelAnswer: '', points: [], rubric: [],
  };

  if (type === 'writing') {
    const format = WRITING_FORMATS.includes(raw.format) ? raw.format : '';
    if (!format) return { error: `${at}: writing blocks need a format (${WRITING_FORMATS.filter(Boolean).join(', ')})` };
    const marks = Number(raw.marks);
    if (!(marks > 0)) return { error: `${at}: marks must be above 0` };
    const scenario = _str(raw.scenario, 3000);
    if (!scenario) return { error: `${at}: scenario is required for a writing block` };
    doc.format = format;
    doc.marks = marks;
    doc.wordLimit = _str(raw.wordLimit, 40);
    doc.scenario = scenario;
    doc.modelAnswer = _str(raw.modelAnswer, 4000);
    doc.passageImage = _str(raw.passageImage, 500); // e.g. the empty diagram skeleton to be filled in
    doc.passage = _str(raw.passage, 8000); // source material shown in a box (advertisement / notice / table / headline / given paragraph)
    doc.points = (Array.isArray(raw.points) ? raw.points : []).map(p => _str(p, 300)).filter(Boolean).slice(0, 20);
    doc.rubric = (Array.isArray(raw.rubric) ? raw.rubric : []).map(p => _str(p, 100)).filter(Boolean).slice(0, 20);
    return { doc };
  }

  const passage = _str(raw.passage, 8000);
  if (!passage && type !== 'nonverbal') return { error: `${at}: passage text is required` };
  if (!Array.isArray(raw.subQuestions) || !raw.subQuestions.length) return { error: `${at}: needs at least one sub-question` };
  if (raw.subQuestions.length > 12) return { error: `${at}: at most 12 sub-questions` };

  const subQuestions = [];
  for (let i = 0; i < raw.subQuestions.length; i++) {
    const sq = raw.subQuestions[i] || {};
    const sqAt = `${at}, sub-question ${i + 1}`;
    const marks = Number(sq.marks);
    if (!(marks > 0)) return { error: `${sqAt}: marks must be above 0` };
    const format = FORMATS.includes(sq.format) ? sq.format : 'short_answer';
    const items = Array.isArray(sq.items) ? sq.items : [];
    if (!items.length) return { error: `${sqAt}: needs at least one item` };
    const cleanItems = [];
    for (const it of items) {
      const text = _str(it?.text, 2000);
      const answer = _str(it?.answer, 1000);
      const given = _str(it?.given, 200);
      if (format === 'web_diagram' || format === 'tree_diagram') {
        if (!given && !answer) return { error: `${sqAt}: a diagram item needs "given" or "answer"` };
      } else if (!answer) {
        return { error: `${sqAt}: every item needs an answer (use a short sample answer for open questions)` };
      }
      cleanItems.push({ text, answer, given });
    }
    subQuestions.push({ marks, format, prompt: _str(sq.prompt, 400), center: _str(sq.center, 200), items: cleanItems });
  }

  doc.passage = passage;
  doc.passageImage = _str(raw.passageImage, 500);
  doc.subQuestions = subQuestions;
  return { doc };
}

function serialize(b) {
  const obj = b.toObject ? b.toObject() : b;
  return { ...obj, id: String(obj._id), totalMarks: (PassageBlock.prototype.totalMarks).call(obj) };
}

// ── Admin: single create/update/list/delete ───────────────────────────────────

exports.createBlock = asyncHandler(async (req, res) => {
  const { error, doc } = validateBlock(req.body, 0);
  if (error) throw new AppError(error, 400);
  const block = await PassageBlock.create(doc);
  invalidateContentAccessCache();
  res.status(201).json({ success: true, data: serialize(block) });
});

exports.updateBlock = asyncHandler(async (req, res) => {
  if (!/^[0-9a-fA-F]{24}$/.test(String(req.params.id))) throw new AppError('Block not found', 404);
  const { error, doc } = validateBlock(req.body, 0);
  if (error) throw new AppError(error, 400);
  const block = await PassageBlock.findByIdAndUpdate(req.params.id, doc, { new: true });
  if (!block) throw new AppError('Block not found', 404);
  invalidateContentAccessCache();
  res.json({ success: true, data: serialize(block) });
});

exports.deleteBlock = asyncHandler(async (req, res) => {
  if (!/^[0-9a-fA-F]{24}$/.test(String(req.params.id))) throw new AppError('Block not found', 404);
  const block = await PassageBlock.findByIdAndDelete(req.params.id);
  if (!block) throw new AppError('Block not found', 404);
  invalidateContentAccessCache();
  res.json({ success: true, message: 'Block deleted' });
});

// GET /api/passage-blocks?batchId=&subjectId=&chapterId=&type=&language=&q=
exports.listBlocks = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.batchId) filter.batchId = String(req.query.batchId);
  if (req.query.subjectId) filter.subjectId = String(req.query.subjectId);
  if (req.query.chapterId !== undefined) filter.chapterId = String(req.query.chapterId); // '' = unseen pool only
  if (req.query.type) filter.type = String(req.query.type);
  if (req.query.language) filter.language = String(req.query.language);
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.q) filter.$or = [{ title: new RegExp(String(req.query.q).slice(0, 100), 'i') }, { passage: new RegExp(String(req.query.q).slice(0, 100), 'i') }];
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
  const rows = await PassageBlock.find(filter).sort({ usageCount: 1, created_at: -1 }).limit(limit);
  res.json({ success: true, data: rows.map(serialize) });
});

exports.getBlock = asyncHandler(async (req, res) => {
  if (!/^[0-9a-fA-F]{24}$/.test(String(req.params.id))) throw new AppError('Block not found', 404);
  const block = await PassageBlock.findById(req.params.id);
  if (!block) throw new AppError('Block not found', 404);
  res.json({ success: true, data: serialize(block) });
});

// ── Admin: bulk JSON import (Claude-generated array, see docs) ────────────────
// Same preview -> run shape as controllers/importController.js's copy importer: nothing is
// saved until /run, and /preview never touches the database.

exports.previewImport = asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body.blocks) ? req.body.blocks : null;
  if (!items || !items.length) throw new AppError('blocks must be a non-empty array', 400);
  if (items.length > 100) throw new AppError('At most 100 blocks per import', 400);
  const results = items.map((raw, i) => {
    const { error, doc } = validateBlock(raw, i);
    return error ? { ok: false, error, index: i } : { ok: true, index: i, preview: doc };
  });
  res.json({
    success: true,
    valid: results.filter(r => r.ok).length,
    invalid: results.filter(r => !r.ok).length,
    results,
  });
});

exports.runImport = asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body.blocks) ? req.body.blocks : null;
  if (!items || !items.length) throw new AppError('blocks must be a non-empty array', 400);
  if (items.length > 100) throw new AppError('At most 100 blocks per import', 400);
  const docs = [];
  for (let i = 0; i < items.length; i++) {
    const { error, doc } = validateBlock(items[i], i);
    if (error) throw new AppError(error, 400); // all-or-nothing: a bad block must not save the good ones
    docs.push(doc);
  }
  const jobId = randomUUID();
  const saved = await PassageBlock.insertMany(docs.map(d => ({ ...d, importJobId: jobId })));
  invalidateContentAccessCache();
  res.status(201).json({ success: true, count: saved.length, importJobId: jobId, data: saved.map(serialize) });
});

exports.undoImport = asyncHandler(async (req, res) => {
  const jobId = String(req.params.jobId || '');
  if (!jobId) throw new AppError('importJobId is required', 400);
  const r = await PassageBlock.deleteMany({ importJobId: jobId });
  invalidateContentAccessCache();
  res.json({ success: true, deleted: r.deletedCount || 0 });
});

// ── Student: Exercise screen practice ─────────────────────────────────────────

// GET /api/passage-blocks/student?chapterId=&type=  (chapterId required, same isolation as
// SLSQuestion's getStudentExerciseQuestions)
exports.getStudentBlocks = asyncHandler(async (req, res) => {
  const { chapterId, type } = req.query;
  if (!chapterId) throw new AppError('chapterId is required', 400);

  const assigned = Array.isArray(req.userDoc?.assigned_batches) ? req.userDoc.assigned_batches : [];
  const chapterBatch = String(chapterId).split('::')[0];
  const allowed = assigned.some(b => String(b).trim().toLowerCase().replace(/\s+/g, '-') === chapterBatch);
  if (assigned.length && !allowed) throw new AppError('Not available for your batch', 403);
  if (!(await canAccessChapterId(req.userDoc, chapterId))) {
    return res.status(403).json(chapterLockedBody());
  }

  const filter = { chapterId, status: 'published' };
  if (type) filter.type = String(type);
  const rows = await PassageBlock.find(filter).sort({ created_at: 1 });
  res.json({ success: true, data: rows.map(serialize) });
});

exports.serialize = serialize;
exports.validateBlock = validateBlock;
