const { randomUUID } = require("crypto");
const QuizPaperPattern = require("../models/QuizPaperPattern");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

const VALID_MODES = new Set(["manual", "random"]);
const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const MAX_SECTIONS = 20;

function normalizeSections(sections) {
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new AppError("sections must be a non-empty array", 400);
  }
  if (sections.length > MAX_SECTIONS) {
    throw new AppError(`sections cannot exceed ${MAX_SECTIONS}`, 400);
  }

  return sections.map((section, index) => {
    const count = Math.max(1, parseInt(section?.count, 10) || 0);
    if (!count) {
      throw new AppError(`sections[${index}].count must be a positive number`, 400);
    }
    const mode = VALID_MODES.has(section?.mode) ? section.mode : "random";
    const difficulty =
      section?.difficulty && VALID_DIFFICULTIES.has(String(section.difficulty).toLowerCase())
        ? String(section.difficulty).toLowerCase()
        : undefined;

    return {
      label: String(section?.label || "").trim(),
      subject: String(section?.subject || "").trim(),
      count,
      mode,
      ...(difficulty ? { difficulty } : {}),
      positive_marks: Number.isFinite(Number(section?.positive_marks)) ? Number(section.positive_marks) : 1,
      negative_marks: Number.isFinite(Number(section?.negative_marks)) ? Number(section.negative_marks) : 0
    };
  });
}

exports.createPattern = asyncHandler(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) throw new AppError("name is required", 400);

  const sections = normalizeSections(req.body?.sections);
  const patternId =
    String(req.body?.pattern_id || "").trim() || `pattern_${randomUUID()}`;

  const existing = await QuizPaperPattern.findOne({ pattern_id: patternId });
  const payload = {
    pattern_id: patternId,
    name,
    description: String(req.body?.description || "").trim(),
    sections,
    updated_at: new Date(),
    created_at: existing?.created_at || new Date()
  };

  let pattern;
  if (existing) {
    Object.assign(existing, payload);
    pattern = await existing.save();
  } else {
    pattern = await QuizPaperPattern.create(payload);
  }

  res.status(existing ? 200 : 201).json({ success: true, data: pattern });
});

exports.getPatterns = asyncHandler(async (req, res) => {
  const patterns = await QuizPaperPattern.find().sort({ updated_at: -1 });
  res.json({ success: true, count: patterns.length, data: patterns });
});

exports.getPatternById = asyncHandler(async (req, res) => {
  const pattern = await QuizPaperPattern.findOne({ pattern_id: req.params.id });
  if (!pattern) throw new AppError("Pattern not found", 404);
  res.json({ success: true, data: pattern });
});

exports.deletePattern = asyncHandler(async (req, res) => {
  const pattern = await QuizPaperPattern.findOneAndDelete({ pattern_id: req.params.id });
  if (!pattern) throw new AppError("Pattern not found", 404);
  res.json({ success: true, data: { pattern_id: pattern.pattern_id } });
});
