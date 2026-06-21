const { randomUUID } = require("crypto");
const Attempt = require("../models/Attempt");
const Quiz = require("../models/Quiz");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const { sendToUser } = require("../utils/fcm");

function normalizeAnswerValue(value) {
  return String(value || "").trim();
}

function normalizeAttemptAnswers(rawAnswers) {
  if (!Array.isArray(rawAnswers)) {
    throw new AppError("answers must be an array", 400);
  }

  const answersByQuestion = new Map();

  rawAnswers.forEach((answer, index) => {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
      throw new AppError(`answers[${index}] must be an object`, 400);
    }

    const qId = String(answer.q_id || "").trim();

    if (!qId) {
      throw new AppError(`answers[${index}].q_id is required`, 400);
    }

    const submittedAnswer =
      answer.submitted_answer !== undefined ? answer.submitted_answer :
      answer.answer        !== undefined ? answer.answer :
      answer.given;

    answersByQuestion.set(qId, normalizeAnswerValue(submittedAnswer));
  });

  return answersByQuestion;
}

exports.createAttempt = asyncHandler(async (req, res) => {
  const quizId = String(req.body.quiz_id || "").trim();
  const studentName = String(req.body.student_name || "Anonymous").trim() || "Anonymous";

  if (!quizId) {
    throw new AppError("quiz_id is required", 400);
  }

  const quiz = await Quiz.findOne({ quiz_id: quizId });

  if (!quiz) {
    throw new AppError("Quiz not found", 404);
  }

  if (quiz.status !== "published") {
    throw new AppError("Only published quizzes can be attempted", 400);
  }

  if (!quiz.questions || quiz.questions.length === 0) {
    throw new AppError("Quiz has no questions", 400);
  }

  if (req.user?.role === 'student') {
    const allowedBatches = Array.isArray(req.userDoc?.assigned_batches)
      ? req.userDoc.assigned_batches.map(item => String(item || '').trim()).filter(Boolean)
      : [];
    if (!allowedBatches.includes(quiz.batch || '')) {
      throw new AppError("Quiz not found", 404);
    }
  }

  const submittedAnswers = normalizeAttemptAnswers(req.body.answers);

  const evaluatedAnswers = quiz.questions.map(question => {
    let submittedAnswer = submittedAnswers.get(question.q_id) || "";

    const answerText =
      question.options && typeof question.options === "object" && !Array.isArray(question.options)
        ? (question.options[question.answer] || question.answer)
        : question.answer;

    if (submittedAnswer && /^[A-Da-d]$/.test(submittedAnswer)) {
      const optText = question.options?.[submittedAnswer.toUpperCase()];
      if (optText) submittedAnswer = optText;
    }

    return {
      q_id: question.q_id,
      submitted_answer: submittedAnswer,
      is_correct: submittedAnswer !== "" && (
        submittedAnswer === question.answer ||
        submittedAnswer === answerText
      ),
    };
  });

  const correctAnswers = evaluatedAnswers.filter(answer => answer.is_correct).length;
  const attemptedAnswers = evaluatedAnswers.filter(answer => answer.submitted_answer !== "").length;
  const totalQuestions = quiz.questions.length;
  const wrongAnswers = attemptedAnswers - correctAnswers;
  const skippedAnswers = totalQuestions - attemptedAnswers;
  const wrongQIds = evaluatedAnswers
    .filter(a => !a.is_correct && a.submitted_answer !== "")
    .map(a => a.q_id);

  // Use client-supplied attempt_id if present (allows idempotent retries from offline sync)
  const clientAttemptId = String(req.body.attempt_id || "").trim();
  if (clientAttemptId) {
    const existing = await Attempt.findOne({ attempt_id: clientAttemptId })
      .select('-wrong_q_ids')
      .lean();
    if (existing) {
      return res.status(200).json({
        success: true,
        data: {
          attempt_id: existing.attempt_id,
          quiz_id: existing.quiz_id,
          quiz_version: existing.quiz_version,
          score: existing.score,
          total_questions: existing.total_questions,
          correct_answers: existing.correct_answers,
          wrong_answers: existing.wrong_answers,
          skipped_answers: existing.skipped_answers,
          submitted_at: existing.submitted_at,
        },
      });
    }
  }

  const studentCode = req.user?.student_code || '';
  const attempt = await Attempt.create({
    attempt_id: clientAttemptId || `attempt_${randomUUID()}`,
    quiz_id: quiz.quiz_id,
    quiz_version: quiz.version,
    quiz_title: quiz.title,
    subject: quiz.subject,
    chapter: quiz.chapter,
    batch: quiz.batch,
    student_name: studentName,
    student_code: studentCode,
    wrong_q_ids: wrongQIds,
    score: correctAnswers,
    total_questions: totalQuestions,
    correct_answers: correctAnswers,
    wrong_answers: wrongAnswers,
    skipped_answers: skippedAnswers,
    submitted_at: new Date()
  });

  // Notify assigned teachers via FCM (non-blocking)
  if (studentCode) {
    _notifyTeachers(studentCode, studentName, quiz.title, correctAnswers, totalQuestions)
      .catch(err => console.warn('FCM teacher notify failed:', err.message));
  }

  res.status(201).json({
    success: true,
    data: {
      attempt_id: attempt.attempt_id,
      quiz_id: attempt.quiz_id,
      quiz_version: attempt.quiz_version,
      score: attempt.score,
      total_questions: attempt.total_questions,
      correct_answers: attempt.correct_answers,
      wrong_answers: attempt.wrong_answers,
      skipped_answers: attempt.skipped_answers,
      submitted_at: attempt.submitted_at
    }
  });
});

async function _notifyTeachers(studentCode, studentName, quizTitle, score, total) {
  const teachers = await User.find({
    role: 'teacher',
    assigned_students: studentCode,
    device_token: { $exists: true, $nin: [null, ''] }
  }).select('device_token').lean();

  const parents = await User.find({
    role: 'parent',
    children: studentCode,
    device_token: { $exists: true, $nin: [null, ''] }
  }).select('device_token').lean();

  const tokens = [
    ...teachers.map(t => t.device_token),
    ...parents.map(p => p.device_token),
  ].filter(Boolean);

  if (!tokens.length) return;

  const title = `${studentName} — Test Complete`;
  const body  = `${quizTitle}: ${score}/${total}`;
  const data  = { student_code: studentCode };

  await Promise.all(tokens.map(token => sendToUser(token, title, body, data).catch(() => {})));
}

// GET /api/attempts/my — student fetches their own attempts
exports.getMyAttempts = asyncHandler(async (req, res) => {
  const studentCode = req.user?.student_code;
  const studentName = req.user?.name;
  if (!studentCode && !studentName) return res.status(401).json({ success: false, message: 'Not authenticated' });

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 1000);
  const skip  = Math.max(parseInt(req.query.skip) || 0, 0);

  const filter = studentCode
    ? { $or: [{ student_code: studentCode }, { student_code: '', student_name: studentName }] }
    : { student_name: studentName };

  const attempts = await Attempt.find(filter)
    .select('-wrong_q_ids')
    .sort({ submitted_at: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  res.json({ success: true, count: attempts.length, skip, limit, data: attempts });
});

exports.getAttempts = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.quiz_id)      filter.quiz_id      = String(req.query.quiz_id).trim();
  if (req.query.student_name) filter.student_name = String(req.query.student_name).trim();
  if (req.query.batch)        filter.batch        = String(req.query.batch).trim();
  if (req.query.student_code) filter.student_code = String(req.query.student_code).trim();

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 1000);
  const skip  = Math.max(parseInt(req.query.skip) || 0, 0);
  const attempts = await Attempt.find(filter)
    .sort({ submitted_at: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  res.json({ success: true, count: attempts.length, skip, limit, data: attempts });
});
