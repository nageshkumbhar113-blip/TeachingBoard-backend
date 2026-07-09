/* ════════════════════════════════════════════════════════════════
   wordTestController.js — Admin + Student endpoints for Word Tests
════════════════════════════════════════════════════════════════ */

const WordTest        = require('../models/WordTest');
const WordTestAttempt = require('../models/WordTestAttempt');
const Word            = require('../models/Word');
const asyncHandler    = require('../utils/asyncHandler');
const AppError        = require('../utils/AppError');
const { getStats }    = require('../engine/WordBankStats');
const { assemble }    = require('../engine/TestAssembler');
const User            = require('../models/User');

// Question type → skill category mapping (used for section_scores)
const SKILL_MAP = {
  listen_choose_word:  'listening',
  listen_pick_picture: 'listening',
  listen_meaning_mr:   'vocabulary',
  listen_spelling:     'spelling',
  listen_type_word:    'spelling',
};

// listStudentTests already checks this correctly — getTestStudent and
// submitAttempt (below) used to only check status:'published', with no
// check that the test's batch matches the requesting student's
// assigned_batches, letting a student view/submit any batch's test given
// its test_id.
function _assertOwnBatch(studentDoc, batch) {
  const assigned = Array.isArray(studentDoc?.assigned_batches) ? studentDoc.assigned_batches : [];
  if (assigned.length > 0 && !assigned.includes(batch)) {
    throw new AppError('Access denied for this batch', 403);
  }
}

// ══════════════════════════════════════════════════════════════════
// ADMIN — Stats (called before creating a test)
// GET /api/admin/word-tests/stats?batch=LKG&subject=Animals
// ══════════════════════════════════════════════════════════════════
exports.getWordBankStats = asyncHandler(async (req, res) => {
  const batch   = String(req.query.batch   || '').trim();
  const subject = String(req.query.subject || '').trim();
  if (!batch)   throw new AppError('batch is required', 400);
  if (!subject) throw new AppError('subject is required', 400);

  const stats = await getStats(batch, subject);
  res.json({ success: true, ...stats });
});

// ══════════════════════════════════════════════════════════════════
// ADMIN — Generate preview (not saved yet)
// POST /api/admin/word-tests/generate
// body: { batch, subject, title, question_configs: [{type, count}] }
// ══════════════════════════════════════════════════════════════════
exports.generatePreview = asyncHandler(async (req, res) => {
  const { batch, subject, title, question_configs } = req.body;

  if (!batch)            throw new AppError('batch is required', 400);
  if (!subject)          throw new AppError('subject is required', 400);
  if (!title || !title.trim()) throw new AppError('title is required', 400);
  if (!Array.isArray(question_configs) || question_configs.length === 0)
    throw new AppError('question_configs must be a non-empty array', 400);

  const { questions, warnings } = await assemble(batch, subject, question_configs);

  if (questions.length === 0)
    throw new AppError('Could not generate any questions. Check word bank and try again.', 422);

  res.json({
    success:         true,
    batch,
    subject,
    title:           title.trim(),
    question_count:  questions.length,
    questions,
    warnings,
  });
});

// ══════════════════════════════════════════════════════════════════
// ADMIN — Save draft
// POST /api/admin/word-tests
// body: { batch, subject, title, questions[], pass_percent? }
// ══════════════════════════════════════════════════════════════════
exports.saveDraft = asyncHandler(async (req, res) => {
  const { batch, subject, title, questions, pass_percent } = req.body;

  if (!batch)                            throw new AppError('batch is required', 400);
  if (!subject)                          throw new AppError('subject is required', 400);
  if (!title || !title.trim())           throw new AppError('title is required', 400);
  if (!Array.isArray(questions) || questions.length === 0)
    throw new AppError('questions must be a non-empty array', 400);

  const test = await WordTest.create({
    title:           title.trim(),
    batch,
    subject,
    status:          'draft',
    questions,
    total_questions: questions.length,
    pass_percent:    Math.min(100, Math.max(0, Number(pass_percent) || 60)),
    created_by:      req.user?.id || '',
  });

  res.status(201).json({ success: true, test_id: test.test_id, message: 'Draft saved.' });
});

// ══════════════════════════════════════════════════════════════════
// ADMIN — Auto-generate tests from Word Bank (20 words per test)
// POST /api/admin/word-tests/auto-generate
// body: { batch, subject, words_per_test?, question_configs?, overwrite? }
// ══════════════════════════════════════════════════════════════════
const DEFAULT_AUTO_CONFIGS = [
  { type: 'listen_choose_word',  count: 5 },
  { type: 'listen_pick_picture', count: 5 },
  { type: 'listen_meaning_mr',   count: 4 },
  { type: 'listen_spelling',     count: 4 },
  { type: 'listen_type_word',    count: 2 },
];
const DEFAULT_WORDS_PER_TEST = 20;

exports.autoGenerate = asyncHandler(async (req, res) => {
  const { batch, subject, words_per_test, question_configs, overwrite } = req.body;

  if (!batch)   throw new AppError('batch is required', 400);
  if (!subject) throw new AppError('subject is required', 400);

  const chunkSize = Math.min(50, Math.max(5, Number(words_per_test) || DEFAULT_WORDS_PER_TEST));
  const configs   = Array.isArray(question_configs) && question_configs.length
    ? question_configs
    : DEFAULT_AUTO_CONFIGS;

  // Check existing draft/published tests for this batch+subject
  const existingCount = await WordTest.countDocuments({ batch, subject });
  if (existingCount > 0 && !overwrite) {
    return res.json({
      success:  false,
      conflict: true,
      existing: existingCount,
      message:  `${existingCount} test(s) already exist for ${batch} › ${subject}. Send overwrite:true to replace.`,
    });
  }

  // Fetch all words sorted by seq_num
  const words = await Word.find({ batch, subject }).sort({ seq_num: 1 }).lean();
  if (words.length === 0) throw new AppError('No words in word bank for this batch+subject', 422);

  // Split into chunks
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize));
  }

  // Delete old tests if overwrite
  if (overwrite && existingCount > 0) {
    await WordTest.deleteMany({ batch, subject });
  }

  const created  = [];
  const warnings = [];

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunkWords  = chunks[idx];
    const wordIds     = new Set(chunkWords.map(w => w.word_id));
    const chunkNum    = idx + 1;
    const title       = `${subject} — Set ${chunkNum}`;

    // assemble uses the full chunk as the word pool
    const result = await assemble(batch, subject, configs, chunkWords);

    if (result.questions.length === 0) {
      warnings.push(`Set ${chunkNum}: no questions generated (${chunkWords.length} words). Skipped.`);
      continue;
    }

    const test = await WordTest.create({
      title,
      batch,
      subject,
      status:          'draft',
      questions:        result.questions,
      total_questions:  result.questions.length,
      pass_percent:     60,
      created_by:       req.user?.id || 'auto',
    });

    created.push({ test_id: test.test_id, title, questions: result.questions.length });
    if (result.warnings.length) warnings.push(...result.warnings.map(w => `Set ${chunkNum}: ${w}`));
  }

  res.status(201).json({
    success:      true,
    created_count: created.length,
    tests:         created,
    warnings,
    message:       `${created.length} test draft(s) created for ${batch} › ${subject}.`,
  });
});

// ══════════════════════════════════════════════════════════════════
// ADMIN — List tests for a batch+subject
// GET /api/admin/word-tests?batch=LKG&subject=Animals
// ══════════════════════════════════════════════════════════════════
exports.listTests = asyncHandler(async (req, res) => {
  const batch   = String(req.query.batch   || '').trim();
  const subject = String(req.query.subject || '').trim();
  const filter  = {};
  if (batch)   filter.batch   = batch;
  if (subject) filter.subject = subject;

  const tests = await WordTest.find(filter, {
    test_id: 1, title: 1, batch: 1, subject: 1,
    status: 1, total_questions: 1, pass_percent: 1,
    created_at: 1, published_at: 1,
  }).sort({ created_at: -1 }).lean();

  res.json({ success: true, count: tests.length, tests });
});

// ══════════════════════════════════════════════════════════════════
// ADMIN — Get one test (full, with questions + correct_id)
// GET /api/admin/word-tests/:test_id
// ══════════════════════════════════════════════════════════════════
exports.getTestAdmin = asyncHandler(async (req, res) => {
  const test = await WordTest.findOne({ test_id: req.params.test_id }).lean();
  if (!test) throw new AppError('Test not found', 404);
  res.json({ success: true, test });
});

// ══════════════════════════════════════════════════════════════════
// ADMIN — Update draft (title, questions, pass_percent)
// PATCH /api/admin/word-tests/:test_id
// ══════════════════════════════════════════════════════════════════
exports.updateTest = asyncHandler(async (req, res) => {
  const test = await WordTest.findOne({ test_id: req.params.test_id });
  if (!test) throw new AppError('Test not found', 404);
  if (test.status === 'published')
    throw new AppError('Published tests cannot be edited. Unpublish first.', 400);

  const { title, questions, pass_percent } = req.body;
  if (title)                      test.title         = title.trim();
  if (Array.isArray(questions))  { test.questions = questions; test.total_questions = questions.length; }
  if (pass_percent !== undefined) test.pass_percent = Math.min(100, Math.max(0, Number(pass_percent) || 60));

  await test.save();
  res.json({ success: true, message: 'Test updated.' });
});

// ══════════════════════════════════════════════════════════════════
// ADMIN — Publish test
// POST /api/admin/word-tests/:test_id/publish
// ══════════════════════════════════════════════════════════════════
exports.publishTest = asyncHandler(async (req, res) => {
  const test = await WordTest.findOne({ test_id: req.params.test_id });
  if (!test) throw new AppError('Test not found', 404);
  if (test.questions.length === 0)
    throw new AppError('Cannot publish a test with no questions.', 400);

  test.status       = 'published';
  test.published_at = new Date();
  await test.save();

  res.json({ success: true, message: 'Test published.' });
});

// ══════════════════════════════════════════════════════════════════
// ADMIN — Unpublish test (back to draft)
// POST /api/admin/word-tests/:test_id/unpublish
// ══════════════════════════════════════════════════════════════════
exports.unpublishTest = asyncHandler(async (req, res) => {
  const test = await WordTest.findOne({ test_id: req.params.test_id });
  if (!test) throw new AppError('Test not found', 404);

  test.status       = 'draft';
  test.published_at = null;
  await test.save();

  res.json({ success: true, message: 'Test unpublished.' });
});

// ══════════════════════════════════════════════════════════════════
// ADMIN — Delete test (only drafts)
// DELETE /api/admin/word-tests/:test_id
// ══════════════════════════════════════════════════════════════════
exports.deleteTest = asyncHandler(async (req, res) => {
  const test = await WordTest.findOne({ test_id: req.params.test_id });
  if (!test) throw new AppError('Test not found', 404);
  if (test.status === 'published')
    throw new AppError('Unpublish the test before deleting.', 400);

  await WordTest.deleteOne({ test_id: req.params.test_id });
  res.json({ success: true, message: 'Test deleted.' });
});

// ══════════════════════════════════════════════════════════════════
// ADMIN — Test results (all student attempts)
// GET /api/admin/word-tests/:test_id/results
// ══════════════════════════════════════════════════════════════════
exports.getTestResults = asyncHandler(async (req, res) => {
  const test = await WordTest.findOne({ test_id: req.params.test_id },
    { test_id: 1, title: 1, total_questions: 1, pass_percent: 1 }).lean();
  if (!test) throw new AppError('Test not found', 404);

  const attempts = await WordTestAttempt.find(
    { test_id: req.params.test_id },
    { attempt_id: 1, student_code: 1, score: 1, total: 1, passed: 1, submitted_at: 1 }
  ).sort({ submitted_at: -1 }).lean();

  const avg = attempts.length
    ? Math.round(attempts.reduce((s, a) => s + (a.score / (a.total || 1)) * 100, 0) / attempts.length)
    : 0;
  const passRate = attempts.length
    ? Math.round(attempts.filter(a => a.passed).length / attempts.length * 100)
    : 0;

  res.json({
    success: true,
    test,
    attempt_count: attempts.length,
    avg_percent:   avg,
    pass_rate:     passRate,
    attempts,
  });
});

// ══════════════════════════════════════════════════════════════════
// STUDENT — List published tests for their batch+subject
// GET /api/word-tests?subject=Animals
// (batch comes from student's JWT payload)
// ══════════════════════════════════════════════════════════════════
exports.listStudentTests = asyncHandler(async (req, res) => {
  const batch   = String(req.query.batch   || '').trim();
  const subject = String(req.query.subject || '').trim();

  if (!batch)   throw new AppError('batch is required', 400);
  if (!subject) throw new AppError('subject is required', 400);

  // Verify the student is allowed to access this batch by checking DB (JWT doesn't carry assigned_batches)
  const studentCode = req.user?.student_code || '';
  if (studentCode) {
    const studentDoc = await require('../models/User').findOne(
      { student_code: studentCode, role: 'student' },
      { assigned_batches: 1 }
    ).lean();
    const assigned = Array.isArray(studentDoc?.assigned_batches) ? studentDoc.assigned_batches : [];
    if (assigned.length > 0 && !assigned.includes(batch))
      throw new AppError('Access denied for this batch', 403);
  }

  const tests = await WordTest.find(
    { batch, subject, status: 'published' },
    { test_id: 1, title: 1, total_questions: 1, pass_percent: 1, published_at: 1 }
  ).sort({ published_at: -1 }).lean();

  const testIds = tests.map(t => t.test_id);

  const attempts = studentCode && testIds.length
    ? await WordTestAttempt.find(
        { test_id: { $in: testIds }, student_code: studentCode },
        { test_id: 1, score: 1, total: 1, passed: 1, submitted_at: 1 }
      ).sort({ submitted_at: -1 }).lean()
    : [];

  // Keep only the latest attempt per test (sort desc ensures first match is latest)
  const attemptMap = {};
  attempts.forEach(a => { if (!attemptMap[a.test_id]) attemptMap[a.test_id] = a; });

  const result = tests.map(t => ({
    ...t,
    my_attempt: attemptMap[t.test_id]
      ? { score: attemptMap[t.test_id].score, total: attemptMap[t.test_id].total,
          passed: attemptMap[t.test_id].passed }
      : null,
  }));

  res.json({ success: true, count: result.length, tests: result });
});

// ══════════════════════════════════════════════════════════════════
// STUDENT — Get test for playing (correct_id removed)
// GET /api/word-tests/:test_id
// ══════════════════════════════════════════════════════════════════
exports.getTestStudent = asyncHandler(async (req, res) => {
  const test = await WordTest.findOne({
    test_id: req.params.test_id,
    status:  'published',
  }).lean();
  if (!test) throw new AppError('Test not found', 404);
  _assertOwnBatch(req.userDoc, test.batch);

  // Strip correct_id and is_correct from options before sending to student
  const safeQuestions = test.questions.map(q => ({
    ...q,
    correct_id: undefined,
    options: q.options.map(o => ({ ...o, is_correct: undefined })),
  }));

  const studentCode = req.user?.student_code || '';
  const myAttempt   = studentCode
    ? await WordTestAttempt.findOne({ test_id: test.test_id, student_code: studentCode },
        { score: 1, total: 1, passed: 1, submitted_at: 1 }).lean()
    : null;

  res.json({
    success: true,
    test: { ...test, questions: safeQuestions },
    my_attempt: myAttempt || null,
  });
});

// ══════════════════════════════════════════════════════════════════
// STUDENT — Submit attempt
// POST /api/word-tests/:test_id/attempt
// body: { answers: [{question_id, selected_id, time_ms}] }
// ══════════════════════════════════════════════════════════════════
exports.submitAttempt = asyncHandler(async (req, res) => {
  const test = await WordTest.findOne({
    test_id: req.params.test_id,
    status:  'published',
  }).lean();
  if (!test) throw new AppError('Test not found', 404);
  _assertOwnBatch(req.userDoc, test.batch);

  const { answers } = req.body;
  if (!Array.isArray(answers)) throw new AppError('answers array required', 400);

  const studentCode = req.user?.student_code || '';
  if (!studentCode) throw new AppError('Student identity missing', 401);

  // One attempt per test (getTestStudent already surfaces `my_attempt` to
  // the frontend so it can show "already attempted" instead of the player —
  // but nothing here enforced that server-side, so a resubmission (retry,
  // race, or a client bug) silently created a second attempt document and
  // skewed class-analytics averages, which sum every attempt).
  const existing = await WordTestAttempt.findOne(
    { test_id: test.test_id, student_code: studentCode },
    { attempt_id: 1, score: 1, total: 1, passed: 1 }
  ).lean();
  if (existing) {
    // Same response shape as a fresh submit, so any caller (retry, race,
    // client bug) handles this identically to a normal success response.
    return res.json({
      success: true,
      attempt_id:      existing.attempt_id,
      score:            existing.score,
      total:            existing.total,
      passed:           existing.passed,
      percent:          existing.total > 0 ? Math.round(existing.score / existing.total * 100) : 0,
      correct_answers:  Object.fromEntries(test.questions.map(q => [q.question_id, q.correct_id])),
      already_submitted: true,
    });
  }

  // Build lookup: question_id → correct_id (server-side, not trusting client)
  const correctMap = Object.fromEntries(
    test.questions.map(q => [q.question_id, { correct_id: q.correct_id, type: q.option_type }])
  );

  let score = 0;
  const scoredAnswers = answers.map(a => {
    const meta      = correctMap[a.question_id];
    if (!meta) return { question_id: a.question_id, selected_id: a.selected_id || null,
                         is_correct: false, time_ms: a.time_ms || 0 };

    let is_correct = false;
    if (meta.type === 'typing') {
      // correct_id is the actual word (stored server-side in TestAssembler)
      is_correct = String(a.selected_id || '').trim().toLowerCase() ===
                   String(meta.correct_id || '').trim().toLowerCase();
    } else {
      is_correct = a.selected_id === meta.correct_id;
    }

    if (is_correct) score++;
    return { question_id: a.question_id, selected_id: a.selected_id || null,
              is_correct, time_ms: a.time_ms || 0 };
  });

  const total  = test.questions.length;
  const passed = total > 0 && (score / total * 100) >= test.pass_percent;

  // Compute section_scores and weak_word_ids from graded answers
  const qMetaMap = Object.fromEntries(
    test.questions.map(q => [q.question_id, { type: q.type, word_id: q.word_id }])
  );
  const secs = {
    listening:  { score: 0, total: 0 },
    vocabulary: { score: 0, total: 0 },
    spelling:   { score: 0, total: 0 },
  };
  const weakSet = new Set();
  scoredAnswers.forEach(a => {
    const meta  = qMetaMap[a.question_id];
    if (!meta) return;
    const skill = SKILL_MAP[meta.type];
    if (!skill) return;
    secs[skill].total++;
    if (a.is_correct) {
      secs[skill].score++;
    } else if (meta.word_id) {
      weakSet.add(meta.word_id);
    }
  });
  const weak_word_ids = [...weakSet].slice(0, 20);

  const attempt = await WordTestAttempt.create({
    test_id:        test.test_id,
    student_code:   studentCode,
    batch:          test.batch,
    subject:        test.subject,
    answers:        scoredAnswers,
    score,
    total,
    passed,
    section_scores: secs,
    weak_word_ids,
  });

  // Return correct answers so student can review after submit
  const correctAnswers = Object.fromEntries(
    test.questions.map(q => [q.question_id, q.correct_id])
  );

  res.json({
    success: true,
    attempt_id:      attempt.attempt_id,
    score,
    total,
    passed,
    percent:         total > 0 ? Math.round(score / total * 100) : 0,
    correct_answers: correctAnswers,
  });
});

// ══════════════════════════════════════════════════════════════════
// STUDENT — My word test analytics
// GET /api/word-tests/analytics?batch=&subject=
// ══════════════════════════════════════════════════════════════════
exports.studentAnalytics = asyncHandler(async (req, res) => {
  const studentCode = req.user?.student_code;
  if (!studentCode) throw new AppError('Student identity missing', 401);

  const batch   = String(req.query.batch   || '').trim();
  const subject = String(req.query.subject || '').trim();

  const filter = { student_code: studentCode };
  if (batch)   filter.batch   = batch;
  if (subject) filter.subject = subject;

  const attempts = await WordTestAttempt.find(filter, {
    test_id: 1, score: 1, total: 1, passed: 1,
    submitted_at: 1, section_scores: 1, weak_word_ids: 1, subject: 1,
  }).sort({ submitted_at: -1 }).limit(20).lean();

  if (!attempts.length) {
    return res.json({
      success: true,
      summary: { attempts: 0, avg_percent: 0, pass_rate: 0 },
      sections: {
        listening:  { avg: null, attempts_with_data: 0 },
        vocabulary: { avg: null, attempts_with_data: 0 },
        spelling:   { avg: null, attempts_with_data: 0 },
      },
      weak_words:   [],
      recent_tests: [],
    });
  }

  // Overall summary
  const pctSum    = attempts.reduce((s, a) => s + (a.total > 0 ? (a.score / a.total) * 100 : 0), 0);
  const passCount = attempts.filter(a => a.passed).length;

  // Section averages — only count attempts that have section data (total > 0)
  const secAgg = {
    listening:  { sum: 0, cnt: 0 },
    vocabulary: { sum: 0, cnt: 0 },
    spelling:   { sum: 0, cnt: 0 },
  };
  attempts.forEach(a => {
    const ss = a.section_scores || {};
    for (const skill of ['listening', 'vocabulary', 'spelling']) {
      const s = ss[skill];
      if (s && s.total > 0) {
        secAgg[skill].sum += (s.score / s.total) * 100;
        secAgg[skill].cnt++;
      }
    }
  });
  const sections = {};
  for (const [skill, d] of Object.entries(secAgg)) {
    sections[skill] = {
      avg:                d.cnt > 0 ? Math.round(d.sum / d.cnt) : null,
      attempts_with_data: d.cnt,
    };
  }

  // Weak words — collect across attempts, rank by frequency, fetch names
  const wordFreq = {};
  attempts.forEach(a => {
    (a.weak_word_ids || []).forEach(wid => { wordFreq[wid] = (wordFreq[wid] || 0) + 1; });
  });
  const topWeakIds = Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
  const weakDocs = topWeakIds.length
    ? await Word.find({ word_id: { $in: topWeakIds } }, { word_id: 1, word: 1, _id: 0 }).lean()
    : [];
  const wordNameMap = Object.fromEntries(weakDocs.map(w => [w.word_id, w.word]));
  const weak_words = topWeakIds.map(wid => ({
    word_id: wid, word: wordNameMap[wid] || wid, miss_count: wordFreq[wid],
  }));

  // Recent tests — fetch titles, build lightweight list
  const testIds  = [...new Set(attempts.map(a => a.test_id))];
  const testDocs = await WordTest.find({ test_id: { $in: testIds } }, { test_id: 1, title: 1, _id: 0 }).lean();
  const titleMap = Object.fromEntries(testDocs.map(t => [t.test_id, t.title]));

  const recent_tests = attempts.slice(0, 10).map(a => {
    const pct = a.total > 0 ? Math.round((a.score / a.total) * 100) : 0;
    const ss  = a.section_scores || {};
    return {
      test_id:      a.test_id,
      title:        titleMap[a.test_id] || 'Word Test',
      subject:      a.subject,
      percent:      pct,
      passed:       a.passed,
      submitted_at: a.submitted_at,
      sections: {
        listening:  ss.listening?.total  > 0 ? Math.round(ss.listening.score  / ss.listening.total  * 100) : null,
        vocabulary: ss.vocabulary?.total > 0 ? Math.round(ss.vocabulary.score / ss.vocabulary.total * 100) : null,
        spelling:   ss.spelling?.total   > 0 ? Math.round(ss.spelling.score   / ss.spelling.total   * 100) : null,
      },
    };
  });

  res.json({
    success: true,
    summary: {
      attempts:    attempts.length,
      avg_percent: Math.round(pctSum / attempts.length),
      pass_rate:   Math.round(passCount / attempts.length * 100),
    },
    sections,
    weak_words,
    recent_tests,
  });
});

// ══════════════════════════════════════════════════════════════════
// ADMIN — Class word test analytics
// GET /api/admin/word-tests/analytics?batch=&subject=
// ══════════════════════════════════════════════════════════════════
exports.classAnalytics = asyncHandler(async (req, res) => {
  const batch   = String(req.query.batch   || '').trim();
  const subject = String(req.query.subject || '').trim();
  if (!batch)   throw new AppError('batch is required', 400);
  if (!subject) throw new AppError('subject is required', 400);

  const attempts = await WordTestAttempt.find({ batch, subject }, {
    student_code: 1, score: 1, total: 1, passed: 1,
    section_scores: 1, weak_word_ids: 1,
  }).lean();

  if (!attempts.length) {
    return res.json({
      success: true,
      class_summary: { students_attempted: 0, avg_percent: 0, pass_rate: 0, sections: {} },
      students: [],
      common_weak_words: [],
    });
  }

  // Aggregate per student
  const sm = {};
  attempts.forEach(a => {
    if (!sm[a.student_code]) {
      sm[a.student_code] = {
        code: a.student_code, attempts: 0, pctSum: 0, pctCnt: 0, passedCnt: 0,
        secs: {
          listening:  { sum: 0, cnt: 0 },
          vocabulary: { sum: 0, cnt: 0 },
          spelling:   { sum: 0, cnt: 0 },
        },
      };
    }
    const s = sm[a.student_code];
    s.attempts++;
    if (a.total > 0) { s.pctSum += (a.score / a.total) * 100; s.pctCnt++; }
    if (a.passed) s.passedCnt++;
    const ss = a.section_scores || {};
    for (const skill of ['listening', 'vocabulary', 'spelling']) {
      const sec = ss[skill];
      if (sec && sec.total > 0) {
        s.secs[skill].sum += (sec.score / sec.total) * 100;
        s.secs[skill].cnt++;
      }
    }
  });

  // Fetch student names
  const codes    = Object.keys(sm);
  const userDocs = await User.find(
    { student_code: { $in: codes }, role: 'student' },
    { student_code: 1, name: 1, _id: 0 }
  ).lean();
  const nameMap = Object.fromEntries(userDocs.map(u => [u.student_code, u.name]));

  // Build student rows
  const students = Object.values(sm).map(s => {
    const avg_percent = s.pctCnt > 0 ? Math.round(s.pctSum / s.pctCnt) : 0;
    const secAvgs = {};
    let weakestSkill = null; let weakestVal = 101;
    for (const skill of ['listening', 'vocabulary', 'spelling']) {
      const v = s.secs[skill].cnt > 0 ? Math.round(s.secs[skill].sum / s.secs[skill].cnt) : null;
      secAvgs[skill] = v;
      if (v !== null && v < weakestVal) { weakestVal = v; weakestSkill = skill; }
    }
    const attention = avg_percent < 50 || Object.values(secAvgs).some(v => v !== null && v < 40);
    return {
      student_code:    s.code,
      name:            nameMap[s.code] || s.code,
      attempts:        s.attempts,
      avg_percent,
      passed_count:    s.passedCnt,
      sections:        secAvgs,
      weakest_section: weakestSkill,
      attention,
    };
  }).sort((a, b) => a.avg_percent - b.avg_percent);

  // Class-wide section averages (average of student averages)
  const classSecs = {
    listening:  { sum: 0, cnt: 0 },
    vocabulary: { sum: 0, cnt: 0 },
    spelling:   { sum: 0, cnt: 0 },
  };
  students.forEach(s => {
    for (const skill of ['listening', 'vocabulary', 'spelling']) {
      if (s.sections[skill] !== null) {
        classSecs[skill].sum += s.sections[skill];
        classSecs[skill].cnt++;
      }
    }
  });
  const classSectionAvgs = {};
  for (const [skill, d] of Object.entries(classSecs)) {
    classSectionAvgs[skill] = { avg: d.cnt > 0 ? Math.round(d.sum / d.cnt) : null };
  }

  const classAvgPct  = students.length
    ? Math.round(students.reduce((s, st) => s + st.avg_percent, 0) / students.length) : 0;
  const classPassRate = attempts.length
    ? Math.round(attempts.filter(a => a.passed).length / attempts.length * 100) : 0;

  // Common weak words
  const wordFreq = {};
  attempts.forEach(a => {
    (a.weak_word_ids || []).forEach(wid => { wordFreq[wid] = (wordFreq[wid] || 0) + 1; });
  });
  const topIds   = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);
  const weakDocs = topIds.length
    ? await Word.find({ word_id: { $in: topIds } }, { word_id: 1, word: 1, _id: 0 }).lean() : [];
  const wNameMap = Object.fromEntries(weakDocs.map(w => [w.word_id, w.word]));
  const common_weak_words = topIds.map(id => ({
    word_id: id, word: wNameMap[id] || id, miss_count: wordFreq[id],
  }));

  res.json({
    success: true,
    class_summary: {
      students_attempted: students.length,
      avg_percent:        classAvgPct,
      pass_rate:          classPassRate,
      sections:           classSectionAvgs,
    },
    students,
    common_weak_words,
  });
});
