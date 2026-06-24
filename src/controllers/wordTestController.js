/* ════════════════════════════════════════════════════════════════
   wordTestController.js — Admin + Student endpoints for Word Tests
════════════════════════════════════════════════════════════════ */

const WordTest        = require('../models/WordTest');
const WordTestAttempt = require('../models/WordTestAttempt');
const asyncHandler    = require('../utils/asyncHandler');
const AppError        = require('../utils/AppError');
const { getStats }    = require('../engine/WordBankStats');
const { assemble }    = require('../engine/TestAssembler');

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

  const { answers } = req.body;
  if (!Array.isArray(answers)) throw new AppError('answers array required', 400);

  const studentCode = req.user?.student_code || '';
  if (!studentCode) throw new AppError('Student identity missing', 401);

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

  const attempt = await WordTestAttempt.create({
    test_id:      test.test_id,
    student_code: studentCode,
    batch:        test.batch,
    subject:      test.subject,
    answers:      scoredAnswers,
    score,
    total,
    passed,
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
