const { randomUUID } = require('crypto');
const Lesson         = require('../models/Lesson');
const asyncHandler   = require('../utils/asyncHandler');

function parseContent(content) {
  if (content === null || content === undefined) return {};
  if (typeof content === 'object')              return content;
  try { return JSON.parse(content); } catch { return { body: String(content) }; }
}

function validatePayload(body) {
  const title   = String(body.title   || '').trim();
  const content = body.content;
  if (!title) return { error: 'title is required' };
  if (content === undefined || content === null ||
      (typeof content === 'string' && !content.trim())) {
    return { error: 'content is required' };
  }
  return {
    payload: {
      title,
      content: typeof content === 'string' ? { body: content.trim() } : content,
      batch:   String(body.batch   || '').trim(),
      subject: String(body.subject || '').trim(),
    },
  };
}

exports.getLessons = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.batch)   filter.batch   = String(req.query.batch).trim();
  if (req.query.subject) filter.subject = String(req.query.subject).trim();

  const rows = await Lesson.find(filter).sort({ updated_at: -1 }).lean();
  res.json({ success: true, count: rows.length, data: rows });
});

exports.createLesson = asyncHandler(async (req, res) => {
  const { error, payload } = validatePayload(req.body);
  if (error) return res.status(400).json({ success: false, message: error });

  const lessonId = String(req.body.id || req.body.lesson_id || '').trim()
    || `lesson_${Date.now()}_${randomUUID().slice(0, 8)}`;

  const lesson = await Lesson.findOneAndUpdate(
    { lesson_id: lessonId },
    { ...payload, lesson_id: lessonId },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  res.status(201).json({ success: true, message: 'Lesson saved', data: lesson });
});

exports.updateLesson = asyncHandler(async (req, res) => {
  const lessonId = req.params.id;
  const existing = await Lesson.findOne({ lesson_id: lessonId });
  if (!existing) {
    return res.status(404).json({ success: false, message: 'Lesson not found' });
  }

  const { error, payload } = validatePayload(req.body);
  if (error) return res.status(400).json({ success: false, message: error });

  Object.assign(existing, payload);
  const updated = await existing.save();
  res.json({ success: true, message: 'Lesson updated', data: updated.toObject() });
});

exports.deleteLesson = asyncHandler(async (req, res) => {
  const deleted = await Lesson.findOneAndDelete({ lesson_id: req.params.id });
  if (!deleted) return res.status(404).json({ success: false, message: 'Lesson not found' });
  res.json({ success: true, message: 'Lesson deleted' });
});
