const { mongoose } = require('../config/db');

/**
 * PassageBlock - a passage/prompt plus its attached sub-questions, used by:
 *   - Exercise screen (student practice: read the passage, reveal each sub-answer)
 *   - Paper Builder board-style "Passage" sections (the whole block goes in as one unit,
 *     never split — see utils/paperSections.js)
 *
 * type:
 *   comprehension / poetry / nonverbal - has a passage, every sub-question has a real answer
 *   writing - no passage, no fixed answer (a letter/essay/speech/story prompt); uses
 *             scenario/points/rubric instead of passage/subQuestions
 *
 * chapterId follows the same composite scheme as SLSQuestion (batch::subject::chapter, see
 * admin-app/exerciseManager.js's _makeChapterId) so the same chapter picker, free-chapter
 * check and Paper Builder chapter filter all work unmodified. Left '' for an "unseen"
 * passage/prompt not tied to any one lesson (most language-paper content works this way).
 */

const subQuestionItemSchema = new mongoose.Schema(
  {
    text: { type: String, default: '', trim: true },     // may contain [[ ]] blanks, same convention as SLSQuestion
    answer: { type: String, default: '', trim: true },
    given: { type: String, default: '', trim: true },     // web/tree diagram: the printed spoke
  },
  { _id: false }
);

const subQuestionSchema = new mongoose.Schema(
  {
    marks: { type: Number, required: true, min: 0 },
    format: {
      type: String,
      enum: ['fill_blanks', 'true_false', 'web_diagram', 'tree_diagram', 'match', 'short_answer', 'rearrange'],
      default: 'short_answer',
    },
    prompt: { type: String, default: '', trim: true },
    center: { type: String, default: '', trim: true },      // web_diagram
    items: { type: [subQuestionItemSchema], default: [] },
  },
  { _id: false }
);

const passageBlockSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['comprehension', 'poetry', 'nonverbal', 'writing'], required: true },
    batchId: { type: String, required: true, trim: true },
    subjectId: { type: String, required: true, trim: true },
    chapterId: { type: String, default: '', trim: true },
    language: { type: String, enum: ['english', 'marathi', 'hindi'], default: 'english' },
    title: { type: String, required: true, trim: true },

    // comprehension / poetry / nonverbal
    passage: { type: String, default: '', trim: true },
    passageImage: { type: String, default: '', trim: true },
    subQuestions: { type: [subQuestionSchema], default: [] },

    // writing
    format: {
      type: String,
      enum: ['', 'formal_letter', 'informal_letter', 'speech', 'story', 'news_report', 'essay', 'dialogue', 'ad'],
      default: '',
    },
    marks: { type: Number, default: 0, min: 0 },
    wordLimit: { type: String, default: '', trim: true },
    scenario: { type: String, default: '', trim: true },
    modelAnswer: { type: String, default: '', trim: true }, // writing: a full sample answer (e.g. a model letter), shown only on the answer sheet / after reveal
    points: { type: [String], default: [] },
    rubric: { type: [String], default: [] },

    status: { type: String, enum: ['draft', 'published'], default: 'published' },
    usageCount: { type: Number, default: 0 },

    // Set only on copies made by Admin > Import, same convention as SLSQuestion/Question/Note.
    importedFrom: { id: { type: String }, batch: { type: String } },
    importJobId: { type: String, index: true },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

passageBlockSchema.index({ batchId: 1, subjectId: 1, chapterId: 1, type: 1 });

// Total marks a block is worth: sum of its sub-questions, or its own `marks` for a writing block.
passageBlockSchema.methods.totalMarks = function totalMarks() {
  if (this.type === 'writing') return this.marks || 0;
  return (this.subQuestions || []).reduce((t, q) => t + (Number(q.marks) || 0), 0);
};

module.exports = mongoose.models.PassageBlock || mongoose.model('PassageBlock', passageBlockSchema);
