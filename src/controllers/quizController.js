const Quiz = require("../models/Quiz");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const { QUIZ_STATUSES, buildQuizDocument, serializeQuiz } = require("../utils/quizPayload");

const MAX_SECTION_COUNT = 200;
const MAX_SECTIONS_PER_REQUEST = 20;

// Same "populated options / resolvable answer" rule normalizeQuestions
// enforces at publish time — filtered out here so a bad bank question never
// makes it into a generated section only to 400 later at publish.
function isPublishable(question) {
  const options = question.options || {};
  const populatedKeys = ["A", "B", "C", "D"].filter(
    key => (options[key] && String(options[key]).trim()) || (question.option_images && question.option_images[key])
  );
  if (populatedKeys.length < 2) return false;
  const answer = String(question.answer || "").trim().toUpperCase();
  return populatedKeys.includes(answer);
}

// Fisher-Yates — guarantees a properly interleaved order regardless of how
// the aggregation pipeline happened to stream results in.
function _shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isAdminRequest(req) {
  return req.user?.role === "admin";
}

function getAllowedBatches(req) {
  if (req.user?.role !== 'student') return null;
  return Array.isArray(req.userDoc?.assigned_batches)
    ? req.userDoc.assigned_batches.map(item => String(item || '').trim()).filter(Boolean)
    : [];
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
  if (req.authDenied) {
    return res.status(403).json({
      success: false,
      message: req.authDenied.message,
      code: req.authDenied.code,
      expiryDate: req.authDenied.expiryDate || '',
    });
  }

  const isAdmin = isAdminRequest(req);
  const statusFilter = parseStatusFilter(req.query.status, isAdmin);
  const filter = {};

  if (statusFilter) {
    filter.status = statusFilter;
  } else if (!isAdmin) {
    filter.status = "published";
  }

  const allowedBatches = getAllowedBatches(req);
  if (allowedBatches && !allowedBatches.length) {
    return res.json({ success: true, count: 0, data: [] });
  }
  if (allowedBatches) {
    filter.batch = { $in: allowedBatches };
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
  if (req.authDenied) {
    return res.status(403).json({
      success: false,
      message: req.authDenied.message,
      code: req.authDenied.code,
      expiryDate: req.authDenied.expiryDate || '',
    });
  }

  const isAdmin = isAdminRequest(req);
  const quiz = await Quiz.findOne({ quiz_id: req.params.id });

  if (!quiz) {
    throw new AppError("Quiz not found", 404);
  }

  if (!isAdmin && quiz.status !== "published") {
    throw new AppError("Quiz not found", 404);
  }

  const allowedBatches = getAllowedBatches(req);
  if (allowedBatches && (!quiz.batch || !allowedBatches.includes(quiz.batch))) {
    throw new AppError("Quiz not found", 404);
  }

  res.json({
    success: true,
    data: serializeQuiz(quiz, {
      includeAnswers: true
    })
  });
});

exports.generateQuestions = asyncHandler(async (req, res) => {
  const sections = Array.isArray(req.body?.sections) ? req.body.sections : null;
  if (!sections || sections.length === 0) {
    throw new AppError("sections must be a non-empty array", 400);
  }
  if (sections.length > MAX_SECTIONS_PER_REQUEST) {
    throw new AppError(`sections cannot exceed ${MAX_SECTIONS_PER_REQUEST}`, 400);
  }

  const results = await Promise.all(
    sections.map(async (section, index) => {
      const key = String(section?.key || "").trim() || `sec_${index}`;
      const batch = String(section?.source_batch || "").trim();
      const subject = String(section?.subject || "").trim();
      const chapter = String(section?.chapter || "").trim();
      const count = Math.min(Math.max(parseInt(section?.count, 10) || 0, 0), MAX_SECTION_COUNT);
      const excludeQIds = Array.isArray(section?.exclude_q_ids)
        ? section.exclude_q_ids.map(id => String(id).trim()).filter(Boolean)
        : [];

      if (!batch || !subject) {
        throw new AppError(`sections[${index}] requires source_batch and subject`, 400);
      }
      if (count <= 0) {
        throw new AppError(`sections[${index}].count must be a positive number`, 400);
      }

      // Source: questions already embedded in existing PUBLISHED quizzes for
      // this batch+subject — not the mostly-empty standalone Question bank.
      // Teachers already author real content by building chapter tests; this
      // reuses that content instead of asking them to build a second bank.
      // chapter omitted = subject-wide (all chapters of this subject), the
      // normal case for scholarship/NMMS-style papers.
      const matchQuiz = { status: "published", batch, subject };
      if (chapter) matchQuiz.chapter = chapter;

      const basePipeline = [
        { $match: matchQuiz },
        { $unwind: "$questions" },
        { $replaceRoot: { newRoot: "$questions" } },
        ...(excludeQIds.length ? [{ $match: { q_id: { $nin: excludeQIds } } }] : []),
        // Dedupe — the same bank question can end up embedded in more than
        // one quiz; `available`/the picked set should count it once.
        { $group: { _id: "$q_id", doc: { $first: "$$ROOT" } } },
        { $replaceRoot: { newRoot: "$doc" } }
      ];

      // Over-sample so filtering out unpublishable questions after the
      // fact still leaves close to `count` results.
      const sampleSize = Math.min(count * 3, MAX_SECTION_COUNT * 3);

      const [sampled, availableAgg] = await Promise.all([
        Quiz.aggregate([...basePipeline, { $sample: { size: sampleSize } }]),
        Quiz.aggregate([...basePipeline, { $count: "total" }])
      ]);
      const available = availableAgg[0]?.total || 0;

      // $sample right after a $group stage (needed above to dedupe q_id)
      // reliably randomizes *which* docs get picked, but in practice the
      // *order* they come back in still tends to cluster by source quiz —
      // i.e. by chapter, since a subject-wide pick draws from several
      // chapter-specific quizzes in turn. Explicit shuffle guarantees a
      // properly interleaved order regardless of that pipeline quirk.
      const questions = _shuffleArray(sampled.filter(isPublishable)).slice(0, count);

      return {
        key,
        requested: count,
        available,
        returned: questions.length,
        questions: questions.map(q => ({
          q_id: q.q_id,
          question: q.question,
          options: q.options,
          answer: q.answer,
          image: q.image || null,
          option_images: q.option_images || {},
          type: "mcq"
        }))
      };
    })
  );

  res.json({ success: true, data: results });
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
