const store        = require('../store');
const asyncHandler = require('../utils/asyncHandler');

function parseContent(content) {
  if (content === null || content === undefined) return {};
  if (typeof content === 'object') return content;
  try { return JSON.parse(content); } catch { return { body: String(content) }; }
}

function validatePayload(body) {
  const title   = String(body.title   || '').trim();
  const content = body.content;
  if (!title) return { error: 'title is required' };
  if (content === undefined || content === null || (typeof content === 'string' && !content.trim())) {
    return { error: 'content is required' };
  }
  return {
    payload: {
      title,
      content: typeof content === 'string' ? { body: content.trim() } : content,
    },
  };
}

exports.getLessons = asyncHandler(async (_req, res) => {
  const rows = store.getAll('lessons').map(r => ({ ...r, content: parseContent(r.content) }));
  res.json({ success: true, count: rows.length, data: rows });
});

exports.createLesson = asyncHandler(async (req, res) => {
  const { error, payload } = validatePayload(req.body);
  if (error) return res.status(400).json({ success: false, message: error });

  const record = store.insert('lessons', {
    id        : `lesson-${Date.now()}`,
    title     : payload.title,
    content   : payload.content,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  res.status(201).json({ success: true, message: 'Lesson saved', data: record });
});

exports.updateLesson = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!store.getById('lessons', id)) {
    return res.status(404).json({ success: false, message: 'Lesson not found' });
  }

  const { error, payload } = validatePayload(req.body);
  if (error) return res.status(400).json({ success: false, message: error });

  const updated = store.update('lessons', id, { ...payload, updated_at: new Date().toISOString() });
  res.json({ success: true, message: 'Lesson updated', data: updated });
});

exports.deleteLesson = asyncHandler(async (req, res) => {
  const removed = store.remove('lessons', req.params.id);
  if (!removed) return res.status(404).json({ success: false, message: 'Lesson not found' });
  res.json({ success: true, message: 'Lesson deleted' });
});
