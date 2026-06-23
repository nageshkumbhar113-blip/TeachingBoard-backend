const express = require('express');
const { requireAdmin, requireStudent } = require('../middleware/auth');
const {
  listWords,
  createWord,
  updateWord,
  deleteWord,
  bulkCreateWords,
  autoFillWord,
  suggestEmoji,
  getVocabSubjects,
  getTestList,
  getTest,
  submitAttempt,
  addStudentWord,
  getVocabConfig,
  saveVocabConfig,
  getTestWordsForAdmin,
  resequenceWords,
} = require('../controllers/wordController');

// ── Admin: /api/admin/words ───────────────────────────────────────────────────
const adminWordRouter = express.Router();
adminWordRouter.get('/vocab-config',    requireAdmin, getVocabConfig);
adminWordRouter.post('/vocab-config',   requireAdmin, saveVocabConfig);
adminWordRouter.get('/test-words',      requireAdmin, getTestWordsForAdmin);
adminWordRouter.post('/resequence',     requireAdmin, resequenceWords);
adminWordRouter.get('/suggest-emoji',   requireAdmin, suggestEmoji);
adminWordRouter.get('/',                requireAdmin, listWords);
adminWordRouter.post('/auto-fill',      requireAdmin, autoFillWord);
adminWordRouter.post('/bulk',           requireAdmin, bulkCreateWords);
adminWordRouter.post('/',               requireAdmin, createWord);
adminWordRouter.patch('/:id',           requireAdmin, updateWord);
adminWordRouter.delete('/:id',          requireAdmin, deleteWord);

// ── Student vocab: /api/vocab ─────────────────────────────────────────────────
const vocabRouter = express.Router();
vocabRouter.get('/auto-fill',        requireStudent, autoFillWord);
vocabRouter.get('/subjects',         requireStudent, getVocabSubjects);
vocabRouter.get('/test-list',        requireStudent, getTestList);
vocabRouter.get('/test/:num',        requireStudent, getTest);
vocabRouter.post('/attempt',         requireStudent, submitAttempt);

// ── Student adds word: /api/student ──────────────────────────────────────────
const studentWordRouter = express.Router();
studentWordRouter.post('/words',     requireStudent, addStudentWord);

module.exports = { adminWordRouter, vocabRouter, studentWordRouter };
