const { randomUUID } = require('crypto');
const Question       = require('../models/Question');
const asyncHandler   = require('../utils/asyncHandler');
const AppError       = require('../utils/AppError');

const VALID_TYPES       = new Set(['mcq', 'tf', 'fib', 'mtp']);
const VALID_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

function normalizeUrl(value) {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function normalizeOptionMap(body, type) {
  if (type === 'tf') {
    return { A: 'True', B: 'False' };
  }

  if (body.options && typeof body.options === 'object' && !Array.isArray(body.options)) {
    return {
      A: String(body.options.A || '').trim(),
      B: String(body.options.B || '').trim(),
      C: String(body.options.C || '').trim(),
      D: String(body.options.D || '').trim(),
    };
  }

  return {
    A: String(body.option1 || '').trim(),
    B: String(body.option2 || '').trim(),
    C: String(body.option3 || '').trim(),
    D: String(body.option4 || '').trim(),
  };
}

function normalizeOptionImages(body) {
  if (body.option_images && typeof body.option_images === 'object' && !Array.isArray(body.option_images)) {
    return {
      A: normalizeUrl(body.option_images.A),
      B: normalizeUrl(body.option_images.B),
      C: normalizeUrl(body.option_images.C),
      D: normalizeUrl(body.option_images.D),
    };
  }

  return {
    A: normalizeUrl(body.option1_image),
    B: normalizeUrl(body.option2_image),
    C: normalizeUrl(body.option3_image),
    D: normalizeUrl(body.option4_image),
  };
}

function normalizeQuestion(body) {
  const question = String(body.question || '').trim();
  if (!question) throw new AppError('question is required', 400);

  const type       = VALID_TYPES.has((body.type || '').toLowerCase()) ? body.type.toLowerCase() : 'mcq';
  const difficulty = VALID_DIFFICULTIES.has((body.difficulty || '').toLowerCase()) ? body.difficulty.toLowerCase() : 'medium';
  const answer     = String(body.answer || '').trim();
  if (!answer) throw new AppError('answer is required', 400);
  const options = normalizeOptionMap(body, type);
  const optionImages = normalizeOptionImages(body);

  return {
    question,
    type,
    difficulty,
    answer,
    options,
    batch:    String(body.batch   || '').trim(),
    subject:  String(body.subject || '').trim(),
    chapter:  String(body.chapter || '').trim(),
    image:    normalizeUrl(body.image),
    option_images: optionImages,
    tags:     Array.isArray(body.tags) ? body.tags.map(String) : [],
  };
}

exports.getQuestions = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.batch)   filter.batch   = String(req.query.batch).trim();
  if (req.query.subject) filter.subject = String(req.query.subject).trim();
  if (req.query.chapter) filter.chapter = String(req.query.chapter).trim();
  if (req.query.type)    filter.type    = String(req.query.type).trim();

  const rows = await Question.find(filter).sort({ created_at: -1 }).lean();
  res.json({ success: true, count: rows.length, data: rows });
});

exports.createQuestion = asyncHandler(async (req, res) => {
  const normalized = normalizeQuestion(req.body);
  const qId = String(req.body.q_id || '').trim() || `q_${randomUUID()}`;

  const question = await Question.findOneAndUpdate(
    { q_id: qId },
    { ...normalized, q_id: qId },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  res.status(201).json({ success: true, message: 'Question saved', data: question });
});

exports.updateQuestion = asyncHandler(async (req, res) => {
  const existing = await Question.findOne({ q_id: req.params.id });
  if (!existing) return res.status(404).json({ success: false, message: 'Question not found' });

  const normalized = normalizeQuestion(req.body);
  Object.assign(existing, normalized);
  const updated = await existing.save();
  res.json({ success: true, message: 'Question updated', data: updated.toObject() });
});

exports.deleteQuestion = asyncHandler(async (req, res) => {
  const deleted = await Question.findOneAndDelete({ q_id: req.params.id });
  if (!deleted) return res.status(404).json({ success: false, message: 'Question not found' });
  res.json({ success: true, message: 'Question deleted' });
});
