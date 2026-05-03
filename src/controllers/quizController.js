const Quiz = require("../models/Quiz");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const { QUIZ_STATUSES, buildQuizDocument, serializeQuiz } = require("../utils/quizPayload");

function isAdminRequest(req) {
  return req.user?.role === "admin";
}

function parseStatusFilter(rawStatus, isAdmin) {
  if (rawStatus === undefined) {
    return null;
  }

  const status = String(rawStatus).trim().toLowerCase();

  if (!QUIZ_STATUSES.has(status)) {
    throw new AppError('status must be either "draft" or "published"', 400);
  }

  // Non-admins must not be able to fetch draft quizzes
  if (status === 'draft' && !isAdmin) {
    throw new AppError('Quiz not found', 404);
  }

  return status;
}

exports.createQuiz = asyncHandler(async (req, res) => {
  const existingQuiz = req.body.quiz_id
    ? await Quiz.findOne({ quiz_id: String(req.body.quiz_id).trim() })
    : null;

  const quizPayload = buildQuizDocument(req.body, existingQuiz);
  let quiz;

  if (existingQuiz) {
    Object.assign(existingQuiz, quizPayload);
    quiz = await existingQuiz.save();
  } else {
    quiz = await Quiz.create(quizPayload);
  }

  res.status(existingQuiz ? 200 : 201).json({
    success: true,
    data: serializeQuiz(quiz, { includeAnswers: true })
  });
});

exports.getQuizzes = asyncHandler(async (req, res) => {
  const isAdmin = isAdminRequest(req);
  const statusFilter = parseStatusFilter(req.query.status, isAdmin);
  const filter = {};

  if (statusFilter) {
    filter.status = statusFilter;
  } else if (!isAdmin) {
    filter.status = "published";
  }

  const quizzes = await Quiz.find(filter).sort({ updated_at: -1 });

  res.json({
    success: true,
    count: quizzes.length,
    data: quizzes.map(quiz =>
      serializeQuiz(quiz, {
        // Student clients cache full quizzes for offline play and local scoring.
        includeAnswers: true
      })
    )
  });
});

exports.getQuizById = asyncHandler(async (req, res) => {
  const isAdmin = isAdminRequest(req);
  const quiz = await Quiz.findOne({ quiz_id: req.params.id });

  if (!quiz) {
    throw new AppError("Quiz not found", 404);
  }

  if (!isAdmin && quiz.status !== "published") {
    throw new AppError("Quiz not found", 404);
  }

  res.json({
    success: true,
    data: serializeQuiz(quiz, {
      includeAnswers: true
    })
  });
});

exports.deleteQuiz = asyncHandler(async (req, res) => {
  const quiz = await Quiz.findOneAndDelete({ quiz_id: req.params.id });

  if (!quiz) {
    throw new AppError("Quiz not found", 404);
  }

  res.json({
    success: true,
    data: {
      quiz_id: quiz.quiz_id
    }
  });
});
