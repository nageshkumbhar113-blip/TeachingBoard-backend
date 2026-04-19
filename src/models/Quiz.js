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
      type: [String],
      required: true,
      validate: {
        validator: value => Array.isArray(value) && value.length >= 2,
        message: "Each question must contain at least 2 options"
      }
    },
    answer: {
      type: String,
      required: true,
      trim: true
    },
    image: {
      type: String,
      default: null
    }
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

module.exports = mongoose.models.Quiz || mongoose.model("Quiz", quizSchema);
