const { mongoose } = require("../config/db");

const quizQuestionSchema = new mongoose.Schema(
  {
    q_id: {
      type: String,
      required: true,
      trim: true
    },
    question: {
      type: String,
      required: true,
      trim: true
    },
    options: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    answer: {
      type: String,
      required: true,
      trim: true
    },
    image: {
      type: String,
      default: null
    },
    option_images: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    // Denormalized per-question marks. Optional/undefined means "legacy" —
    // absence, not a default, is what keeps old quiz docs byte-identical.
    marks: {
      type: Number,
      min: 0
    },
    negative_marks: {
      type: Number,
      min: 0
    }
  },
  {
    _id: false
  }
);

// Purely additive overlay metadata describing how a quiz's flat questions[]
// are grouped into sections (e.g. for a mixed/section-wise paper). The flat
// questions[] array stays the source of truth for every consumer; a legacy
// quiz simply has no sections at all.
const quizSectionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    label: { type: String, trim: true, default: "" },
    type: { type: String, trim: true, default: "mcq" },
    question_ids: { type: [String], default: [] },
    source_batch: { type: String, trim: true, default: "" },
    subject: { type: String, trim: true, default: "" },
    chapter: { type: String, trim: true, default: "" },
    count: { type: Number, min: 0 },
    mode: { type: String, enum: ["manual", "random"], default: "manual" },
    positive_marks: { type: Number, min: 0 },
    negative_marks: { type: Number, min: 0 },
    timer: { type: Number, min: 0 }
  },
  {
    _id: false
  }
);

const quizSchema = new mongoose.Schema(
  {
    quiz_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    chapter: {
      type: String,
      required: true,
      trim: true
    },
    batch: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    status: {
      type: String,
      enum: ["draft", "published"],
      default: "draft",
      index: true
    },
    timer_mode: {
      type: String,
      required: true,
      trim: true
    },
    timer_value: {
      type: Number,
      required: true,
      min: 0
    },
    shuffle: {
      type: Boolean,
      default: false
    },
    questions: {
      type: [quizQuestionSchema],
      required: true,
      validate: {
        validator: value => Array.isArray(value) && value.length > 0,
        message: "A quiz must contain at least one question"
      }
    },
    // Additive overlay for Mixed/section-wise papers. `default: undefined`
    // (not []) is deliberate — a legacy quiz document must never gain a
    // `sections` key just from being re-saved; presence is the discriminator.
    sections: {
      type: [quizSectionSchema],
      default: undefined
    },
    positive_marks: {
      type: Number,
      min: 0
    },
    negative_marks: {
      type: Number,
      min: 0
    },
    paper_mode: {
      type: String,
      enum: ["manual", "random", "mixed"]
    },
    created_at: {
      type: Date,
      required: true,
      default: Date.now
    },
    updated_at: {
      type: Date,
      required: true,
      default: Date.now
    },
    version: {
      type: Number,
      required: true,
      min: 1,
      default: 1
    }
  },
  {
    versionKey: false,
    strict: "throw"
  }
);

// Matches the $match shape used by the random-question-pick endpoint
// (POST /api/quizzes/generate-questions), which sources questions from
// existing published quizzes' embedded questions[] rather than the
// separate (usually much sparser) Question bank. (batch,subject) prefix
// also serves the subject-wide — chapter omitted — case.
quizSchema.index({ status: 1, batch: 1, subject: 1, chapter: 1 });

module.exports = mongoose.models.Quiz || mongoose.model("Quiz", quizSchema);
