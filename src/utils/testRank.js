const Attempt = require('../models/Attempt');

// Live rank on one test: every person counts once, with their BEST result
// (so retrying never inflates the field). Marks-based % (negative marking and
// multi-mark questions), falling back to correct/total for old attempts.
async function rankOnTest(quizId, studentCode) {
  const rows = await Attempt.aggregate([
    { $match: { quiz_id: String(quizId), student_code: { $nin: ['', null] } } },
    { $project: {
      student_code: 1,
      pct: { $cond: [
        { $gt: ['$max_marks', 0] }, { $divide: ['$marks_obtained', '$max_marks'] },
        { $cond: [{ $gt: ['$total_questions', 0] }, { $divide: ['$score', '$total_questions'] }, 0] },
      ] },
    } },
    { $group: { _id: '$student_code', best: { $max: '$pct' } } },
  ]);
  const total = rows.length;
  const mine = rows.find(r => r._id === studentCode);
  if (!mine) return { total, rank: null, best_pct: null };
  const rank = 1 + rows.filter(r => r.best > mine.best).length;
  return { total, rank, best_pct: Math.round(Math.max(0, mine.best) * 100) };
}

module.exports = { rankOnTest };
