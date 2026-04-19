const store        = require('../store');
const asyncHandler = require('../utils/asyncHandler');

function normalizeAnswer(answer) {
  const v = String(answer || '').trim().toLowerCase();
  const map = { '1': 'option1', '2': 'option2', '3': 'option3', '4': 'option4',
    option1: 'option1', option2: 'option2', option3: 'option3', option4: 'option4' };
  return map[v] || '';
}

function validatePayload(body) {
  const p = {
    question: String(body.question || '').trim(),
    option1 : String(body.option1  || '').trim(),
    option2 : String(body.option2  || '').trim(),
    option3 : String(body.option3  || '').trim(),
    option4 : String(body.option4  || '').trim(),
    answer  : normalizeAnswer(body.answer),
  };
  if (!p.question || !p.option1 || !p.option2 || !p.option3 || !p.option4) {
    return { error: 'question, option1–4 are required' };
  }
  if (!p.answer) return { error: 'answer must be option1–4 or 1–4' };
  return { payload: p };
}

exports.getQuestions = asyncHandler(async (_req, res) => {
  const rows = store.getAll('questions');
  res.json({ success: true, count: rows.length, data: rows });
});

exports.createQuestion = asyncHandler(async (req, res) => {
  const { error, payload } = validatePayload(req.body);
  if (error) return res.status(400).json({ success: false, message: error });

  const record = store.insert('questions', { id: `q-${Date.now()}`, ...payload });
  res.status(201).json({ success: true, message: 'Question created', data: record });
});

exports.updateQuestion = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!store.getById('questions', id)) {
    return res.status(404).json({ success: false, message: 'Question not found' });
  }

  const { error, payload } = validatePayload(req.body);
  if (error) return res.status(400).json({ success: false, message: error });

  const updated = store.update('questions', id, payload);
  res.json({ success: true, message: 'Question updated', data: updated });
});

exports.deleteQuestion = asyncHandler(async (req, res) => {
  const removed = store.remove('questions', req.params.id);
  if (!removed) return res.status(404).json({ success: false, message: 'Question not found' });
  res.json({ success: true, message: 'Question deleted' });
});
