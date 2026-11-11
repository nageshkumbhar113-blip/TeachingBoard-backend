// 7 pm (IST) study notification for students with full access (paid / activated) — owner's choice 2026-11-08.
// One a day at most, never a "free test" or an offer. Skipped for a student with an active Study Plan (it has its own
// morning / evening pushes) and for one who already took a test today. The notification names one thing to do and
// carries its quiz id, so the app (8.9.0+) opens that very test on a tap.
//   Saturday + registered for tomorrow's महा-Test → the महा-Test reminder
//   3 days in a row → the streak + the next test
//   a weak score in the last 7 days (< 50 %) → that test again
//   else → the next test of the class not taken yet (subject → chapter → title order)
// 14 quiet days (no test, no login) → stop; one "come back" push a week instead.
const User = require('../models/User');
const Attempt = require('../models/Attempt');
const Quiz = require('../models/Quiz');
const StudyPlan = require('../models/StudyPlan');
const WeeklyEvent = require('../models/WeeklyEvent');
const WeeklyEntry = require('../models/WeeklyEntry');
const { hasFullAccess } = require('./contentAccess');
const { sendToUser } = require('./fcm');

const IST = 5.5 * 3600e3;
const dayOf = t => new Date(new Date(t).getTime() + IST).toISOString().slice(0, 10);
const pctOf = a => { const max = a.max_marks || a.total_questions || 0; const got = a.max_marks ? a.marks_obtained : a.score; return max ? Math.round((got / max) * 100) : 0; };
const label = q => [q.subject, q.chapter].filter(Boolean).join(' — ') || q.title || 'test';

async function messageFor(s, now) {
  const today = dayOf(now), code = s.student_code, batch = (s.assigned_batches || [])[0] || '';
  const recent = await Attempt.find({ student_code: code }, 'quiz_id score total_questions marks_obtained max_marks submitted_at').sort({ submitted_at: -1 }).limit(60).lean();
  if (recent.some(a => dayOf(a.submitted_at) === today)) return null;                  // studied today already
  const quiet = (!recent[0] || now - new Date(recent[0].submitted_at) > 14 * 864e5) && (!s.last_login_at || now - new Date(s.last_login_at) > 14 * 864e5);
  if (quiet) {
    if (s.comeback_at && now - new Date(s.comeback_at) < 7 * 864e5) return null;
    return { title: '📚 परत अभ्यास सुरू करूया?', body: `${s.name || ''} — फक्त 10 मिनिटं, आजची एक test`.trim(), data: { type: 'study_nudge', kind: 'comeback' }, comeback: true };
  }
  // Saturday: tomorrow's महा-Test
  if (new Date(now.getTime() + IST).getUTCDay() === 6 && batch) {
    const ev = await WeeklyEvent.findOne({ batch, is_trial: { $ne: true }, status: { $ne: 'skipped' }, starts_at: { $gt: now, $lt: new Date(now.getTime() + 36 * 3600e3) } }).sort({ starts_at: 1 }).lean();
    if (ev && await WeeklyEntry.exists({ event_id: String(ev._id), student_code: code })) {
      return { title: '🏆 उद्या महा-Test', body: 'नोंदणी झाली आहे — आज थोडा सराव करा, उद्या वेळेवर या', data: { type: 'study_nudge', kind: 'maha' } };
    }
  }
  const taken = new Set(recent.map(a => a.quiz_id));
  const quizzes = batch ? await Quiz.find({ batch, status: 'published' }, 'quiz_id title subject chapter questions').lean() : [];
  quizzes.sort((a, b) => String(a.subject).localeCompare(String(b.subject)) || String(a.chapter).localeCompare(String(b.chapter), undefined, { numeric: true }) || String(a.title).localeCompare(String(b.title), undefined, { numeric: true }));
  const next = quizzes.find(q => !taken.has(q.quiz_id));
  // 3 days in a row
  const days = new Set(recent.map(a => dayOf(a.submitted_at)));
  const d = k => dayOf(now.getTime() - k * 864e5);
  if (days.has(d(1)) && days.has(d(2)) && days.has(d(3)) && next) {
    return { title: '🔥 3 दिवस सलग! आजही एक test', body: `${label(next)} · ${(next.questions || []).length || ''} प्रश्न`.replace(/ · $/, ''), data: { type: 'study_nudge', kind: 'streak', quiz_id: next.quiz_id } };
  }
  // a weak score this week → that test again
  const weak = recent.find(a => now - new Date(a.submitted_at) < 7 * 864e5 && pctOf(a) < 50);
  const wq = weak && quizzes.find(q => q.quiz_id === weak.quiz_id);
  if (wq) {
    const max = weak.max_marks || weak.total_questions, got = weak.max_marks ? weak.marks_obtained : weak.score;
    return { title: `🔁 पुन्हा सराव: ${wq.chapter || wq.title}`, body: `मागच्या वेळी ${got}/${max} — आज जास्त गुण मिळवा`, data: { type: 'study_nudge', kind: 'again', quiz_id: wq.quiz_id } };
  }
  if (next) return { title: `📝 आजची test: ${label(next)}`, body: `${next.title}${(next.questions || []).length ? ' · ' + next.questions.length + ' प्रश्न' : ''}`, data: { type: 'study_nudge', kind: 'next', quiz_id: next.quiz_id } };
  return null;
}

async function sendStudyNudges(now = new Date()) {
  const today = dayOf(now);
  const students = await User.find({ role: 'student', status: 'active', device_token: { $exists: true, $nin: [null, ''] }, study_nudge_date: { $ne: today } },
    'user_id name student_code assigned_batches device_token free_tier expiry_date role last_login_at comeback_at').limit(3000).lean();
  const withPlan = new Set((await StudyPlan.find({ status: 'active' }, 'studentUserId').lean()).map(p => p.studentUserId));
  let sent = 0;
  for (const s of students) {
    if (!hasFullAccess(s) || withPlan.has(s.user_id)) continue;
    try {
      const m = await messageFor(s, now);
      await User.updateOne({ user_id: s.user_id }, { $set: { study_nudge_date: today, ...(m?.comeback ? { comeback_at: now } : {}) } });
      if (!m) continue;
      await sendToUser(s.device_token, m.title, m.body, m.data);
      sent++;
    } catch (err) { console.warn('study nudge', s.student_code, err.message); }
  }
  return sent;
}

module.exports = { sendStudyNudges, messageFor };
