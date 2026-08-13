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

function normalizeMarksValue(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new AppError(`${fieldName} must be a non-negative number`, 400);
  }
  return num;
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

    const marks = normalizeMarksValue(question.marks, `questions[${index}].marks`);
    const negativeMarks = normalizeMarksValue(question.negative_marks, `questions[${index}].negative_marks`);

    return {
      q_id: normalizeString(question.q_id, `questions[${index}].q_id`, { required: false }) || `q_${randomUUID()}`,
      question: normalizeString(question.question, `questions[${index}].question`),
      options,
      answer,
      option_images: optionImages,
      image:
        question.image === undefined || question.image === null || question.image === ""
          ? null
          : normalizeString(question.image, `questions[${index}].image`),
      // Omit entirely when absent so legacy submissions round-trip byte-identical.
      ...(marks !== undefined ? { marks } : {}),
      ...(negativeMarks !== undefined ? { negative_marks: negativeMarks } : {})
    };
  });
}

function normalizeSections(sections, questions) {
  if (!Array.isArray(sections) || sections.length === 0) {
    return undefined;
  }

  const validQIds = new Set((questions || []).map(q => q.q_id));

  const normalized = sections
    .map((section, index) => {
      if (!section || typeof section !== "object" || Array.isArray(section)) {
        throw new AppError(`sections[${index}] must be an object`, 400);
      }

      const questionIds = Array.isArray(section.question_ids)
        ? section.question_ids.map(id => normalizeString(id, `sections[${index}].question_ids[]`))
        : [];

      questionIds.forEach(qId => {
        if (!validQIds.has(qId)) {
          throw new AppError(
            `sections[${index}].question_ids references q_id "${qId}" which is not present in questions[]`,
            400
          );
        }
      });

      if (questionIds.length === 0) {
        return null; // drop empty sections
      }

      const type = normalizeString(section.type || "mcq", `sections[${index}].type`, { required: false }) || "mcq";
      if (type !== "mcq") {
        throw new AppError(`sections[${index}].type must be "mcq"`, 400);
      }

      const mode = section.mode === "random" ? "random" : "manual";

      return {
        id: normalizeString(section.id, `sections[${index}].id`, { required: false }) || `sec_${randomUUID()}`,
        label: normalizeString(section.label, `sections[${index}].label`, { required: false }),
        type,
        question_ids: questionIds,
        source_batch: normalizeString(section.source_batch, `sections[${index}].source_batch`, { required: false }),
        subject: normalizeString(section.subject, `sections[${index}].subject`, { required: false }),
        chapter: normalizeString(section.chapter, `sections[${index}].chapter`, { required: false }),
        mode,
        ...(section.count !== undefined && section.count !== null && section.count !== ""
          ? { count: Number(section.count) }
          : {}),
        ...(() => {
          const pm = normalizeMarksValue(section.positive_marks, `sections[${index}].positive_marks`);
          return pm !== undefined ? { positive_marks: pm } : {};
        })(),
        ...(() => {
          const nm = normalizeMarksValue(section.negative_marks, `sections[${index}].negative_marks`);
          return nm !== undefined ? { negative_marks: nm } : {};
        })(),
        ...(section.timer !== undefined && section.timer !== null && section.timer !== ""
          ? { timer: Number(section.timer) }
          : {})
      };
    })
    .filter(Boolean);

  return normalized.length > 0 ? normalized : undefined;
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
  const questions = normalizeQuestions(payload.questions);
  const sections = normalizeSections(payload.sections, questions);
  const positiveMarks = normalizeMarksValue(payload.positive_marks, "positive_marks");
  const negativeMarks = normalizeMarksValue(payload.negative_marks, "negative_marks");
  const paperMode =
    payload.paper_mode && ["manual", "random", "chapter_random", "mixed"].includes(payload.paper_mode)
      ? payload.paper_mode
      : undefined;

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
    questions,
    created_at: createdAt,
    updated_at: new Date(),
    version: existingQuiz ? existingQuiz.version + 1 : 1,
    // Omitted entirely when absent — legacy publish payloads produce a
    // document with no `sections`/`positive_marks`/... keys at all.
    ...(sections ? { sections } : {}),
    ...(positiveMarks !== undefined ? { positive_marks: positiveMarks } : {}),
    ...(negativeMarks !== undefined ? { negative_marks: negativeMarks } : {}),
    ...(paperMode ? { paper_mode: paperMode } : {})
  };
}

function sanitizeQuestions(questions, includeAnswers) {
  return questions.map(question => ({
    q_id: question.q_id,
    question: question.question,
    options: question.options,
    image: question.image || null,
    option_images: question.option_images || {},
    ...(includeAnswers ? { answer: question.answer } : {}),
    ...(question.marks !== undefined && question.marks !== null ? { marks: question.marks } : {}),
    ...(question.negative_marks !== undefined && question.negative_marks !== null
      ? { negative_marks: question.negative_marks }
      : {})
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
    version: source.version,
    // Only emitted when the source document actually has them — a legacy
    // quiz's serialized JSON must stay character-for-character identical.
    ...(source.sections ? { sections: source.sections } : {}),
    ...(source.positive_marks !== undefined && source.positive_marks !== null
      ? { positive_marks: source.positive_marks }
      : {}),
    ...(source.negative_marks !== undefined && source.negative_marks !== null
      ? { negative_marks: source.negative_marks }
      : {}),
    ...(source.paper_mode ? { paper_mode: source.paper_mode } : {})
  };
}

module.exports = {
  QUIZ_STATUSES,
  buildQuizDocument,
  serializeQuiz
};
