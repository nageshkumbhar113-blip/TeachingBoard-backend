const { mongoose } = require("../config/db");

const attemptSchema = new mongoose.Schema(
  {
    attempt_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true
    },
    quiz_id: {
      type: String,
      required: true,
      index: true,
      trim: true
    },
    quiz_version: {
      type: Number,
      required: true,
      min: 1
    },
    quiz_title: {
      type: String,
      required: true,
      trim: true
    },
    subject: {
      type: String,
      required: true,
      trim: true
    },
    chapter: {
      type: String,
      required: true,
      trim: true
    },
    batch: {
      type: String,
      required: true,
      trim: true
    },
    student_name: {
      type: String,
      required: true,
      trim: true
    },
    student_code: {
      type: String,
      default: '',
      trim: true,
      index: true
    },
    // IDs of questions answered incorrectly — used by teacher/parent dashboard
    wrong_q_ids: {
      type: [String],
      default: []
    },
    score: {
      type: Number,
      required: true,
      min: 0
    },
    total_questions: {
      type: Number,
      required: true,
      min: 0
    },
    correct_answers: {
      type: Number,
      required: true,
      min: 0
    },
    wrong_answers: {
      type: Number,
      required: true,
      min: 0
    },
    skipped_answers: {
      type: Number,
      required: true,
      min: 0
    },
    submitted_at: {
      type: Date,
      required: true,
      default: Date.now,
      index: true
    }
  },
  {
    versionKey: false,
    strict: "throw"
  }
);

module.exports = mongoose.models.Attempt || mongoose.model("Attempt", attemptSchema);
