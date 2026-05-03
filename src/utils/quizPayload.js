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

function normalizeUrl(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return normalizeString(value, fieldName);
}

function normalizeOptionImages(value, index) {
  const fieldName = `questions[${index}].option_images`;

  if (value === undefined || value === null || value === "") {
    return { A: null, B: null, C: null, D: null };
  }

  if (Array.isArray(value)) {
    return {
      A: normalizeUrl(value[0], `${fieldName}[0]`),
      B: normalizeUrl(value[1], `${fieldName}[1]`),
      C: normalizeUrl(value[2], `${fieldName}[2]`),
      D: normalizeUrl(value[3], `${fieldName}[3]`),
    };
  }

  if (typeof value === "object") {
    return {
      A: normalizeUrl(value.A, `${fieldName}.A`),
      B: normalizeUrl(value.B, `${fieldName}.B`),
      C: normalizeUrl(value.C, `${fieldName}.C`),
      D: normalizeUrl(value.D, `${fieldName}.D`),
    };
  }

  throw new AppError(`${fieldName} must be an object or array`, 400);
}

function normalizeQuestionOptions(question, index) {
  const fieldName = `questions[${index}].options`;

  if (Array.isArray(question.options)) {
    const values = question.options.map((option, optionIndex) =>
      normalizeString(option, `${fieldName}[${optionIndex}]`, { required: false })
    );

    return {
      A: values[0] || "",
      B: values[1] || "",
      C: values[2] || "",
      D: values[3] || "",
    };
  }

  if (question.options && typeof question.options === "object") {
    return {
      A: normalizeString(question.options.A, `${fieldName}.A`, { required: false }),
      B: normalizeString(question.options.B, `${fieldName}.B`, { required: false }),
      C: normalizeString(question.options.C, `${fieldName}.C`, { required: false }),
      D: normalizeString(question.options.D, `${fieldName}.D`, { required: false }),
    };
  }

  throw new AppError(`${fieldName} must be an object or array`, 400);
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new AppError("questions must be a non-empty array", 400);
  }

  return questions.map((question, index) => {
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      throw new AppError(`questions[${index}] must be an object`, 400);
    }

    const options = normalizeQuestionOptions(question, index);
    const optionImages = normalizeOptionImages(question.option_images, index);
    const answerInput = normalizeString(question.answer, `questions[${index}].answer`);

    const populatedKeys = ["A", "B", "C", "D"].filter(key =>
      options[key] || optionImages[key]
    );
    if (populatedKeys.length < 2) {
      throw new AppError(`questions[${index}] must contain at least 2 populated options`, 400);
    }

    let answer = answerInput.toUpperCase();
    if (!["A", "B", "C", "D"].includes(answer)) {
      const answerByText = populatedKeys.find(key => options[key] === answerInput);
      if (!answerByText) {
        throw new AppError(
          `questions[${index}].answer must be A/B/C/D or match one of the provided option texts`,
          400
        );
      }
      answer = answerByText;
    }

    if (!populatedKeys.includes(answer)) {
      throw new AppError(`questions[${index}].answer must point to a populated option`, 400);
    }

    return {
      q_id: normalizeString(question.q_id, `questions[${index}].q_id`, { required: false }) || `q_${randomUUID()}`,
      question: normalizeString(question.question, `questions[${index}].question`),
      options,
      answer,
      option_images: optionImages,
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
    title:   normalizeString(payload.title,   "title"),
    subject: normalizeString(payload.subject, "subject", { required: false }),
    chapter: normalizeString(payload.chapter, "chapter", { required: false }),
    batch:   normalizeString(payload.batch,   "batch",   { required: false }),
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
    option_images: question.option_images || {},
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
