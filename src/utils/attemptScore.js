/**
 * Attempt marks — the single place the server turns answers into marks, and
 * the aggregation expressions dashboards use to turn attempts into a %.
 *
 * Marks per question follow the student app exactly (testPlayer.js
 * _decorateQuestionForPlay / _submitTest): the question's own marks, else
 * its section's, else the quiz's, else 1; negative marks the same way, else 0;
 * the total never goes below 0. So the % a teacher or parent sees matches the
 * score the student saw. The section that "owns" a question is the first one
 * listing it — the same rule publishing uses (core/sync.js).
 */

function computeMarks(quiz, evaluatedAnswers) {
  const owner = new Map();
  for (const s of quiz.sections || []) {
    for (const qId of s.question_ids || []) if (!owner.has(qId)) owner.set(qId, s);
  }
  const byId = new Map(evaluatedAnswers.map(a => [a.q_id, a]));
  let obtained = 0;
  let max = 0;
  for (const q of quiz.questions || []) {
    const sec = owner.get(q.q_id) || {};
    const pos = Number(q.marks ?? sec.positive_marks ?? quiz.positive_marks ?? 1) || 0;
    const neg = Number(q.negative_marks ?? sec.negative_marks ?? quiz.negative_marks ?? 0) || 0;
    max += pos;
    const a = byId.get(q.q_id);
    if (!a || a.submitted_answer === '') continue;
    obtained += a.is_correct ? pos : -neg;
  }
  return {
    marks_obtained: Math.max(0, Math.round(obtained * 100) / 100),
    max_marks: Math.round(max * 100) / 100,
  };
}

// For $group stages: marks when the attempt has them, else the old
// correct-count / question-count pair — so old and new attempts mix safely.
const OBTAINED = { $ifNull: ['$marks_obtained', '$score'] };
const MAXIMUM = { $ifNull: ['$max_marks', '$total_questions'] };

module.exports = { computeMarks, OBTAINED, MAXIMUM };
