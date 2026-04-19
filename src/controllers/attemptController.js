const { randomUUID } = require("crypto");
const Attempt = require("../models/Attempt");
const Quiz = require("../models/Quiz");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

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

  const submittedAnswers = normalizeAttemptAnswers(req.body.answers);

  const LETTER_INDEX = { a: 0, b: 1, c: 2, d: 3 };

  const evaluatedAnswers = quiz.questions.map(question => {
    let submittedAnswer = submittedAnswers.get(question.q_id) || "";

    // Resolve MCQ letter (A/B/C/D) to option value for correct server-side scoring
    if (submittedAnswer && Array.isArray(question.options) && question.options.length > 0) {
      const idx = LETTER_INDEX[submittedAnswer.toLowerCase()];
      if (idx !== undefined && question.options[idx] !== undefined) {
        submittedAnswer = String(question.options[idx]);
      }
    }

    return {
      q_id: question.q_id,
      submitted_answer: submittedAnswer,
      is_correct: submittedAnswer !== "" && submittedAnswer === question.answer
    };
  });

  const correctAnswers = evaluatedAnswers.filter(answer => answer.is_correct).length;
  const attemptedAnswers = evaluatedAnswers.filter(answer => answer.submitted_answer !== "").length;
  const totalQuestions = quiz.questions.length;
  const wrongAnswers = attemptedAnswers - correctAnswers;
  const skippedAnswers = totalQuestions - attemptedAnswers;

  const attempt = await Attempt.create({
    attempt_id: `attempt_${randomUUID()}`,
    quiz_id: quiz.quiz_id,
    quiz_version: quiz.version,
    quiz_title: quiz.title,
    subject: quiz.subject,
    chapter: quiz.chapter,
    batch: quiz.batch,
    student_name: studentName,
    answers: evaluatedAnswers,
    score: correctAnswers,
    total_questions: totalQuestions,
    correct_answers: correctAnswers,
    wrong_answers: wrongAnswers,
    skipped_answers: skippedAnswers,
    submitted_at: new Date()
  });

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

exports.getAttempts = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.quiz_id)      filter.quiz_id      = String(req.query.quiz_id).trim();
  if (req.query.student_name) filter.student_name = String(req.query.student_name).trim();
  if (req.query.batch)        filter.batch        = String(req.query.batch).trim();

  const attempts = await Attempt.find(filter).sort({ submitted_at: -1 });

  res.json({ success: true, count: attempts.length, data: attempts });
});
