const { mongoose } = require("../config/db");

// Reusable paper structure — e.g. "NMMS Pattern": Section1=Maths 25Q,
// Section2=Science 25Q, Section3=Mental Ability 25Q — saved once, applied
// to build a Mixed test again and again without re-typing the structure.
// Deliberately does NOT carry batch/chapter: a pattern is subject+count+marks
// shaped, the batch is picked per-quiz at creation time, and random sections
// are subject-wide (no chapter) by design — see quizController.generateQuestions.
const patternSectionSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      trim: true,
      default: ""
    },
    subject: {
      type: String,
      trim: true,
      default: ""
    },
    count: {
      type: Number,
      required: true,
      min: 1
    },
    mode: {
      type: String,
      enum: ["manual", "random"],
      default: "random"
    },
    difficulty: {
      type: String,
      enum: ["easy", "medium", "hard"]
    },
    positive_marks: {
      type: Number,
      min: 0,
      default: 1
    },
    negative_marks: {
      type: Number,
      min: 0,
      default: 0
    }
  },
  {
    _id: false
  }
);

const quizPaperPatternSchema = new mongoose.Schema(
  {
    pattern_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      trim: true,
      default: ""
    },
    sections: {
      type: [patternSectionSchema],
      required: true,
      validate: {
        validator: value => Array.isArray(value) && value.length > 0,
        message: "A pattern must contain at least one section"
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
    }
  },
  {
    versionKey: false,
    strict: "throw"
  }
);

module.exports =
  mongoose.models.QuizPaperPattern || mongoose.model("QuizPaperPattern", quizPaperPatternSchema);
