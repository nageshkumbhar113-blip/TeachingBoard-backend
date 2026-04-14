const { query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");

function normalizeAnswer(answer) {
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

function validateQuestionPayload(body) {
  const payload = {
    question: String(body.question || "").trim(),
    option1: String(body.option1 || "").trim(),
    option2: String(body.option2 || "").trim(),
    option3: String(body.option3 || "").trim(),
    option4: String(body.option4 || "").trim(),
    answer: normalizeAnswer(body.answer)
  };

  if (!payload.question || !payload.option1 || !payload.option2 || !payload.option3 || !payload.option4) {
    return { error: "question, option1, option2, option3, and option4 are required" };
  }

  if (!payload.answer) {
    return { error: "answer must be one of option1, option2, option3, option4 or 1-4" };
  }

  return { payload };
}

exports.getQuestions = asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT id, question, option1, option2, option3, option4, answer
     FROM questions
     ORDER BY id DESC`
  );

  res.json({
    success: true,
    count: rows.length,
    data: rows
  });
});

exports.createQuestion = asyncHandler(async (req, res) => {
  const { error, payload } = validateQuestionPayload(req.body);

  if (error) {
    return res.status(400).json({
      success: false,
      message: error
    });
  }

  const result = await query(
    `INSERT INTO questions (question, option1, option2, option3, option4, answer)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      payload.question,
      payload.option1,
      payload.option2,
      payload.option3,
      payload.option4,
      payload.answer
    ]
  );

  res.status(201).json({
    success: true,
    message: "Question created successfully",
    data: {
      id: result.insertId,
      ...payload
    }
  });
});

exports.updateQuestion = asyncHandler(async (req, res) => {
  const questionId = Number(req.params.id);

  if (!Number.isInteger(questionId) || questionId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Valid question id is required"
    });
  }

  const existing = await query("SELECT id FROM questions WHERE id = ? LIMIT 1", [questionId]);

  if (!existing.length) {
    return res.status(404).json({
      success: false,
      message: "Question not found"
    });
  }

  const { error, payload } = validateQuestionPayload(req.body);

  if (error) {
    return res.status(400).json({
      success: false,
      message: error
    });
  }

  await query(
    `UPDATE questions
     SET question = ?, option1 = ?, option2 = ?, option3 = ?, option4 = ?, answer = ?
     WHERE id = ?`,
    [
      payload.question,
      payload.option1,
      payload.option2,
      payload.option3,
      payload.option4,
      payload.answer,
      questionId
    ]
  );

  res.json({
    success: true,
    message: "Question updated successfully",
    data: {
      id: questionId,
      ...payload
    }
  });
});

exports.deleteQuestion = asyncHandler(async (req, res) => {
  const questionId = Number(req.params.id);

  if (!Number.isInteger(questionId) || questionId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Valid question id is required"
    });
  }

  const result = await query("DELETE FROM questions WHERE id = ?", [questionId]);

  if (result.affectedRows === 0) {
    return res.status(404).json({
      success: false,
      message: "Question not found"
    });
  }

  res.json({
    success: true,
    message: "Question deleted successfully"
  });
});
