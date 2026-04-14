const { pool, query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { decodeTokenFromHeader } = require("../utils/token");

function normalizeSubmittedAnswer(answer) {
  const value = String(answer || "").trim().toLowerCase();
  const mapping = {
    "1": "option1",
    "2": "option2",
    "3": "option3",
    "4": "option4",
    option1: "option1",
    option2: "option2",
    option3: "option3",
    option4: "option4"
  };

  return mapping[value] || "";
}

exports.getQuiz = asyncHandler(async (req, res) => {
  const limit = Number(req.query.limit || 10);
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;

  const rows = await query(
    `SELECT id, question, option1, option2, option3, option4
     FROM questions
     ORDER BY RAND()
     LIMIT ?`,
    [safeLimit]
  );

  res.json({
    success: true,
    count: rows.length,
    data: rows
  });
});

exports.submitQuiz = asyncHandler(async (req, res) => {
  const rawAnswers = Array.isArray(req.body.answers) ? req.body.answers : [];
  const tokenPayload = decodeTokenFromHeader(req.headers.authorization);
  const fallbackName = tokenPayload && tokenPayload.role === "student" ? tokenPayload.name : "";
  const studentName = String(req.body.studentName || fallbackName || "").trim();

  if (!studentName) {
    return res.status(400).json({
      success: false,
      message: "studentName is required"
    });
  }

  if (!rawAnswers.length) {
    return res.status(400).json({
      success: false,
      message: "answers must be a non-empty array"
    });
  }

  const questionIds = rawAnswers
    .map((item) => Number(item.questionId))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (!questionIds.length) {
    return res.status(400).json({
      success: false,
      message: "Each answer must contain a valid questionId"
    });
  }

  const placeholders = questionIds.map(() => "?").join(", ");
  const questions = await query(
    `SELECT id, question, answer
     FROM questions
     WHERE id IN (${placeholders})`,
    questionIds
  );

  const answerMap = new Map(questions.map((question) => [question.id, question]));

  const evaluatedAnswers = rawAnswers
    .map((item) => {
      const questionId = Number(item.questionId);
      const question = answerMap.get(questionId);

      if (!question) {
        return null;
      }

      const submittedAnswer = normalizeSubmittedAnswer(item.answer);
      const isCorrect = submittedAnswer === question.answer;

      return {
        questionId,
        submittedAnswer,
        correctAnswer: question.answer,
        isCorrect
      };
    })
    .filter(Boolean);

  const total = evaluatedAnswers.length;

  if (!total) {
    return res.status(400).json({
      success: false,
      message: "Submitted question ids were not found"
    });
  }

  const score = evaluatedAnswers.filter((item) => item.isCorrect).length;

  const [result] = await pool.execute(
    "INSERT INTO results (student_name, score, total) VALUES (?, ?, ?)",
    [studentName, score, total]
  );

  res.status(201).json({
    success: true,
    message: "Quiz submitted successfully",
    data: {
      resultId: result.insertId,
      studentName,
      score,
      total,
      answers: evaluatedAnswers
    }
  });
});
