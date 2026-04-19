const { randomUUID } = require("crypto");
const AppError = require("./AppError");

const QUIZ_STATUSES = new Set(["draft", "published"]);

function normalizeString(value, fieldName, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) {
      throw new AppError(`${fieldName} is required`, 400);
    }
    return "";
  }

  const normalized = String(value).trim();

  if (!normalized && required) {
    throw new AppError(`${fieldName} is required`, 400);
  }

  return normalized;
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new AppError("questions must be a non-empty array", 400);
  }

  return questions.map((question, index) => {
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      throw new AppError(`questions[${index}] must be an object`, 400);
    }

    const options = Array.isArray(question.options)
      ? question.options.map((option, optionIndex) => {
          const normalizedOption = normalizeString(
            option,
            `questions[${index}].options[${optionIndex}]`
          );
          return normalizedOption;
        })
      : null;

    if (!options || options.length < 2) {
      throw new AppError(`questions[${index}].options must contain at least 2 values`, 400);
    }

    const answer = normalizeString(question.answer, `questions[${index}].answer`);

    if (!options.includes(answer)) {
      throw new AppError(
        `questions[${index}].answer must match one of the provided options`,
        400
      );
    }

    return {
      q_id: normalizeString(question.q_id, `questions[${index}].q_id`, { required: false }) || `q_${randomUUID()}`,
      question: normalizeString(question.question, `questions[${index}].question`),
      options,
      answer,
      image:
        question.image === undefined || question.image === null || question.image === ""
          ? null
          : normalizeString(question.image, `questions[${index}].image`)
    };
  });
}

function buildQuizDocument(payload, existingQuiz = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError("Quiz payload must be an object", 400);
  }

  const status = normalizeString(payload.status || "draft", "status").toLowerCase();

  if (!QUIZ_STATUSES.has(status)) {
    throw new AppError('status must be either "draft" or "published"', 400);
  }

  const timerValue =
    payload.timer_value === undefined || payload.timer_value === null || payload.timer_value === ""
      ? 0
      : Number(payload.timer_value);

  if (!Number.isFinite(timerValue) || timerValue < 0) {
    throw new AppError("timer_value must be a non-negative number", 400);
  }

  const createdAt = existingQuiz?.created_at || new Date();

  return {
    quiz_id:
      normalizeString(payload.quiz_id, "quiz_id", { required: false }) || `quiz_${randomUUID()}`,
    title: normalizeString(payload.title, "title"),
    subject: normalizeString(payload.subject, "subject"),
    chapter: normalizeString(payload.chapter, "chapter"),
    batch: normalizeString(payload.batch, "batch"),
    status,
    timer_mode: normalizeString(payload.timer_mode || "none", "timer_mode"),
    timer_value: timerValue,
    shuffle: Boolean(payload.shuffle),
    questions: normalizeQuestions(payload.questions),
    created_at: createdAt,
    updated_at: new Date(),
    version: existingQuiz ? existingQuiz.version + 1 : 1
  };
}

function sanitizeQuestions(questions, includeAnswers) {
  return questions.map(question => ({
    q_id: question.q_id,
    question: question.question,
    options: question.options,
    image: question.image || null,
    ...(includeAnswers ? { answer: question.answer } : {})
  }));
}

function serializeQuiz(quiz, { includeAnswers = false } = {}) {
  const source = typeof quiz.toObject === "function" ? quiz.toObject() : quiz;

  return {
    quiz_id: source.quiz_id,
    title: source.title,
    subject: source.subject,
    chapter: source.chapter,
    batch: source.batch,
    status: source.status,
    timer_mode: source.timer_mode,
    timer_value: source.timer_value,
    shuffle: source.shuffle,
    questions: sanitizeQuestions(source.questions || [], includeAnswers),
    created_at: source.created_at,
    updated_at: source.updated_at,
    version: source.version
  };
}

module.exports = {
  QUIZ_STATUSES,
  buildQuizDocument,
  serializeQuiz
};
