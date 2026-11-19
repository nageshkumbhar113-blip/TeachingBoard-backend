/**
 * In-process scheduler for student push notifications that can't fire
 * synchronously from a single request:
 *   1. Debounced "new Exercise questions" pushes (many publish calls → one push)
 *   2. Daily "haven't studied in N days" reminder
 *   3. Daily motivation quote
 *   4. Abandoned-checkout "complete your payment" nudge
 *
 * There IS an external cron already hitting this backend — see
 * paymentController.processExpiryReminders / POST /api/payment/process-expiry-reminders,
 * guarded by an x-cron-secret header — but that's a per-feature endpoint
 * tied to whatever schedule was configured for it outside this repo. Rather
 * than add more cron-secret endpoints and depend on someone wiring up new
 * external schedules for each one, these four run on a plain setInterval as
 * long as the Node process stays up. Call start() once from server.js after
 * the DB connects.
 */

const User = require('../models/User');
const StudentProgress = require('../models/StudentProgress');
const StudentSubscription = require('../models/StudentSubscription');
const NotificationQueue = require('../models/NotificationQueue');
const SchedulerState = require('../models/SchedulerState');
const DefaultBannerQuote = require('../models/DefaultBannerQuote');
const StudyPlan = require('../models/StudyPlan');
const StudyTask = require('../models/StudyTask');
const studyPlan = require('../utils/studyPlan');
const { notifyBatch, notifyStudent } = require('../utils/studentNotify');
const { sendToMany } = require('../utils/fcm');
const { parentTokensFor } = require('../utils/parentTokens');
// 🔔 the admin's notification timetable: each job's time / on-off (Admin › Notifications), see utils/notifySchedule.js
const NS = require('../utils/notifySchedule');

const QUEUE_POLL_MS       = 5 * 60 * 1000;   // check the debounce queue every 5 min
const QUEUE_QUIET_MS      = 2 * 60 * 1000;   // ...but only send once a batch/chapter has been quiet 2 min
const INACTIVITY_DAYS     = 3;               // confirmed 3-day "haven't studied" reminder
const PAYMENT_REMINDER_MS = 60 * 60 * 1000;  // give a checkout 1 hour before calling it abandoned

function _todayStr() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD', UTC — fine for a once-a-day gate
}

// ── 1. Debounced Exercise-publish notifications ─────────────────────────────
async function _processExerciseQueue() {
  const cutoff = new Date(Date.now() - QUEUE_QUIET_MS);
  const pending = await NotificationQueue.find({
    type: 'exercise', notified: false, updated_at: { $lte: cutoff },
  }).lean();

  for (const row of pending) {
    try {
      await notifyBatch(
        row.batchId,
        '📗 नवीन Exercise आले!',
        `${row.subjectId} मध्ये नवीन प्रश्न जोडले — आत्ताच सोडवा`,
        { type: 'new_exercise', batch: row.batchId, chapterId: row.chapterId }
      );
    } catch (err) {
      console.warn('exercise queue notify failed:', err.message);
    }
    // Mark done regardless of send outcome — a stuck row would otherwise
    // resend forever every poll; sendToMany already swallows its own errors.
    await NotificationQueue.updateOne({ _id: row._id }, { $set: { notified: true } }).catch(() => {});
  }
}

// ── 2. Daily "haven't studied in N days" reminder ───────────────────────────
async function _sendInactivityReminders() {
  const cutoff = new Date(Date.now() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000);

  // Most recent activity per student, from their concept/notes reading progress.
  const lastActive = await StudentProgress.aggregate([
    { $group: { _id: '$student_code', last: { $max: '$lastAccessedAt' } } },
  ]);
  const lastActiveMap = new Map(lastActive.map(r => [r._id, r.last]));

  const students = await User.find({
    role: 'student',
    device_token: { $exists: true, $nin: [null, ''] },
  }).select('user_id student_code device_token created_at last_inactivity_reminder_at').lean();

  for (const s of students) {
    const last = lastActiveMap.get(s.student_code) || s.created_at; // never opened anything → measure from signup
    if (last > cutoff) continue; // active recently — skip

    // Already reminded for this same quiet stretch — don't re-fire daily.
    if (s.last_inactivity_reminder_at && s.last_inactivity_reminder_at > last) continue;

    await sendToMany(
      [s.device_token],
      '📚 अभ्यास करायला विसरलात का?',
      `${INACTIVITY_DAYS} दिवसांपासून तुम्ही काहीच वाचलेलं नाही — आत्ताच Notes/Exercise बघा!`,
      { type: 'inactivity_reminder' }
    ).catch(err => console.warn('inactivity reminder send failed:', err.message));

    await User.updateOne({ user_id: s.user_id }, { $set: { last_inactivity_reminder_at: new Date() } }).catch(() => {});
  }
}

// ── 3. Daily motivation quote ───────────────────────────────────────────────
async function _sendDailyMotivation() {
  const quotes = await DefaultBannerQuote.find({ active: true }).select('text').lean();
  if (!quotes.length) return;
  const quote = quotes[Math.floor(Math.random() * quotes.length)].text;

  const students = await User.find({
    role: 'student',
    device_token: { $exists: true, $nin: [null, ''] },
  }).select('user_id device_token').lean();
  const withPlan = new Set((await StudyPlan.find({ status: 'active' }, 'studentUserId').lean()).map(p => p.studentUserId));
  const tokens = [...new Set(students.filter(s => !withPlan.has(s.user_id)).map(s => s.device_token).filter(Boolean))];
  if (!tokens.length) return;

  await sendToMany(tokens, '✨ आजचा विचार', quote, { type: 'daily_motivation' }).catch(err =>
    console.warn('daily motivation send failed:', err.message)
  );
}

// ── 4. Abandoned-checkout "complete your payment" nudge ─────────────────────
// Runs on the regular 5-min poll (not the once-a-day gate) since it has its
// own one-time-ever dedupe via payment_reminder_sent, and giving up-to-an-hour
// -old abandoned checkouts a prompt sooner rather than waiting for the next
// calendar day is the whole point.
async function _sendPendingPaymentReminders() {
  const cutoff = new Date(Date.now() - PAYMENT_REMINDER_MS);
  const pending = await StudentSubscription.find({
    status: 'created',
    payment_verified: false,
    payment_reminder_sent: false,
    created_at: { $lte: cutoff },
  }).lean();
  if (!pending.length) return;

  const userIds = [...new Set(pending.map(p => p.student_user_id))];
  const students = await User.find({
    user_id: { $in: userIds },
    device_token: { $exists: true, $nin: [null, ''] },
  }).select('user_id device_token').lean();
  const tokenByUserId = new Map(students.map(s => [s.user_id, s.device_token]));

  for (const sub of pending) {
    const token = tokenByUserId.get(sub.student_user_id);
    if (token) {
      await sendToMany(
        [token],
        '💳 तुमची नोंदणी अपूर्ण आहे',
        `${sub.batch} साठी payment पूर्ण झालेलं नाही — आत्ताच पूर्ण करून access मिळवा`,
        { type: 'pending_payment', batch: sub.batch, period: sub.period }
      ).catch(err => console.warn('pending payment reminder send failed:', err.message));
    }
    // Mark sent even with no device token on file — a one-time nudge, not a
    // retry queue; re-attempting forever for a student who never registered
    // a token would just accumulate dead work every poll.
    await StudentSubscription.updateOne({ _id: sub._id }, { $set: { payment_reminder_sent: true } }).catch(() => {});
  }
}

// ── 5. Study Plan: morning "today's tasks" push (student) ───────────────────
// Also generates the day's tasks server-side so they exist even if the student never opens the
// app until later — utils/studyPlan.generateTasksForDate is idempotent, safe to call again here
// even though getMyToday (controller) calls it too on demand.
async function _sendStudyPlanMorningPush() {
  const plans = await StudyPlan.find({ status: 'active' });
  for (const plan of plans) {
    try {
      // only makes the day's tasks now: the student gets ONE push a day, the 5 pm Personal Digital Teacher one
      await studyPlan.getTodayTasks(plan);
    } catch (err) {
      console.warn('study plan morning push failed for', plan.studentUserId, ':', err.message);
    }
  }
}

// ── 6. Study Plan: evening "pending" reminder (student) + daily summary (parent) ────────────────
async function _sendStudyPlanEveningJobs() {
  const today = studyPlan.todayStr();
  const plans = await StudyPlan.find({ status: 'active' });
  for (const plan of plans) {
    try {
      const tasks = await StudyTask.find({ studyPlanId: plan._id, date: today }).lean();
      if (!tasks.length) continue;
      const completed = tasks.filter(t => t.status === 'completed').length;
      const pending = tasks.length - completed;

      void pending;   // the student's reminder is the 5 pm teacher push (_sendTeacherChatPush)

      // Parent accounts keep their children in `children` (they have no
      // student_code), so the old { role:'parent', student_code } query never
      // matched anyone and this report was never delivered.
      const tokens = await parentTokensFor([plan.studentCode]);
      if (tokens.length) {
        const percent = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
        await sendToMany(tokens, '📖 आजचा अभ्यास अहवाल',
          `आज ${tasks.length} पैकी ${completed} Study Items पूर्ण झाले. Progress: ${percent}%.`,
          { type: 'study_plan_parent_daily', planId: String(plan._id) }).catch(() => {});
      }
    } catch (err) {
      console.warn('study plan evening job failed for', plan.studentUserId, ':', err.message);
    }
  }
}

// ── 7. Study Plan: weekly teacher digest ─────────────────────────────────────
// A snapshot, not a week-over-week delta (no history stored yet — a V2 addition) — one push per
// teacher who has students with an active plan, not one push per student.
async function _sendStudyPlanTeacherDigest() {
  const teachers = await User.find({ role: 'teacher', status: 'active', device_token: { $exists: true, $nin: [null, ''] }, 'assigned_students.0': { $exists: true } }).select('user_id device_token assigned_students').lean();
  for (const t of teachers) {
    try {
      const plans = await StudyPlan.find({ studentCode: { $in: t.assigned_students }, status: 'active' });
      if (!plans.length) continue;
      let sumPercent = 0;
      let behindCount = 0;
      for (const plan of plans) {
        const progress = await studyPlan.getProgress(plan);
        sumPercent += progress.overallPercent;
        if (progress.onTrack.status === 'behind') behindCount++;
      }
      const avgPercent = Math.round(sumPercent / plans.length);
      await sendToMany([t.device_token], '📊 Weekly Study Plan Summary',
        `${plans.length} विद्यार्थ्यांची study plan चालू आहे, सरासरी ${avgPercent}% पूर्ण. ${behindCount} विद्यार्थी मागे आहेत.`,
        { type: 'study_plan_teacher_weekly' }).catch(() => {});
    } catch (err) {
      console.warn('study plan teacher digest failed for', t.user_id, ':', err.message);
    }
  }
}

function _isoWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ── 6b. Personal Digital Teacher: ONE push a day that brings the student to the chat (owner 2026-11-15) ──
// 5 pm IST (after school), only when today's Study Plan tasks are pending AND the app was not opened today
// (users.last_seen_day, set by /auth/me). Greetings / reminders live inside the chat, not in notifications.
// Not sent once the free days are over (nothing is open to study). TEACHER_PUSH_HOUR_IST, TEACHER_PUSH=off.
const TEACHER_PUSH_HOUR_IST = Number(process.env.TEACHER_PUSH_HOUR_IST) || 17;
async function _sendTeacherChatPush(now = new Date()) {
  const today = studyPlan.todayStr(now);
  const { freeWindowOver } = require('../utils/contentAccess');
  const plans = await StudyPlan.find({ status: 'active' }).lean();
  const Batch = require('../models/Batch');
  const mediumOf = new Map();
  let sent = 0;
  for (const plan of plans) {
    try {
      const u = await User.findOne({ user_id: plan.studentUserId, role: 'student', status: 'active' }, 'user_id name role free_tier created_at student_code last_seen_day device_token assigned_batches').lean();
      if (!u || !u.device_token || u.last_seen_day === today || freeWindowOver(u)) continue;
      const pending = await StudyTask.countDocuments({ studyPlanId: plan._id, date: today, status: 'pending' });
      if (!pending) continue;
      const first = String(u.name || '').trim().split(/\s+/)[0];
      // the class's medium decides the language (English medium never gets Marathi)
      const batch = (u.assigned_batches || [])[0];
      if (batch && !mediumOf.has(batch)) mediumOf.set(batch, (await Batch.findOne({ name: batch }, 'medium').lean())?.medium || '');
      const m = mediumOf.get(batch) || '', lang = /hindi/i.test(m) ? 'hi' : (/english/i.test(m) && !/semi/i.test(m)) ? 'en' : 'mr';
      const who = first ? first + ', ' : '';
      const body = lang === 'en' ? `${who}${pending} ${pending === 1 ? 'task is' : 'tasks are'} waiting for you today. Give it 10 minutes!`
        : lang === 'hi' ? `${who}आज ${pending} काम आपका इंतज़ार कर ${pending === 1 ? 'रहा है' : 'रहे हैं'}। 10 मिनट दीजिए!`
        : `${who}आज ${pending} ${pending === 1 ? 'काम' : 'कामं'} तुमची वाट पाहत ${pending === 1 ? 'आहे' : 'आहेत'}. 10 मिनिटं द्या!`;
      await notifyStudent(u.user_id, '🧑‍🏫 Personal Digital Teacher', body, { type: 'teacher_chat' });
      sent++;
    } catch (err) {
      console.warn('teacher push failed for', plan.studentUserId, ':', err.message);
    }
  }
  return sent;
}
async function _runTeacherChatPushIfNeeded() {
  if (String(process.env.TEACHER_PUSH || '').toLowerCase() === 'off') return;
  const ist = _istNow();
  if (!(await NS.due('teacher_chat'))) return;   // was: ist.hour < TEACHER_PUSH_HOUR_IST
  const KEY = 'teacher_chat_push';
  const state = await SchedulerState.findOne({ key: KEY }).lean();
  if (state?.last_run_date === ist.date) return;
  await SchedulerState.updateOne({ key: KEY }, { $set: { last_run_date: ist.date } }, { upsert: true });
  await _sendTeacherChatPush().catch(err => console.warn('teacher push failed:', err.message));
}

// "Evening" means evening in India. The old gate used the server's local hour,
// and Render runs in UTC, so 18:00 there was 23:30 IST — and if the free-tier
// instance was asleep at that hour the push was skipped for the whole day.
// Hour and date are both taken in IST. STUDY_PLAN_EVENING_HOUR_IST tunes it.
const EVENING_HOUR_IST = Number(process.env.STUDY_PLAN_EVENING_HOUR_IST) || 18;

function _istNow(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return { hour: ist.getUTCHours(), date: ist.toISOString().slice(0, 10) };
}

async function _runStudyPlanEveningJobsIfNeeded() {
  const ist = _istNow();
  if (!(await NS.due('plan_evening'))) return;   // was: ist.hour < EVENING_HOUR_IST
  const KEY = 'study_plan_evening';
  const today = ist.date;
  const state = await SchedulerState.findOne({ key: KEY }).lean();
  if (state?.last_run_date === today) return;
  await SchedulerState.updateOne({ key: KEY }, { $set: { last_run_date: today } }, { upsert: true });
  await _sendStudyPlanEveningJobs().catch(err => console.warn('study plan evening job failed:', err.message));
}

// Free-part visitors with the app (utils/guestReminders.js): once a day, in
// the IST evening. GUEST_REMINDERS=off switches it off without a deploy.
async function _runGuestRemindersIfNeeded() {
  if (String(process.env.GUEST_REMINDERS || '').toLowerCase() === 'off') return;
  const ist = _istNow();
  if (!(await NS.due('guest'))) return;   // was: ist.hour < EVENING_HOUR_IST
  const KEY = 'guest_reminders';
  const state = await SchedulerState.findOne({ key: KEY }).lean();
  if (state?.last_run_date === ist.date) return;
  await SchedulerState.updateOne({ key: KEY }, { $set: { last_run_date: ist.date } }, { upsert: true });
  await require('../utils/guestReminders').sendGuestReminders(ist.date).catch(err => console.warn('guest reminders failed:', err.message));
}

// Paid / activated students without a Study Plan (utils/studyNudges.js): one study push at 7 pm IST.
// STUDY_NUDGE_HOUR_IST tunes the hour; STUDY_NUDGES=off switches it off without a deploy.
const STUDY_NUDGE_HOUR_IST = Number(process.env.STUDY_NUDGE_HOUR_IST) || 19;
async function _runStudyNudgesIfNeeded() {
  if (String(process.env.STUDY_NUDGES || '').toLowerCase() === 'off') return;
  const ist = _istNow();
  if (!(await NS.due('nudge'))) return;   // was: ist.hour < STUDY_NUDGE_HOUR_IST (7 pm — the SAT paper's time)
  const KEY = 'study_nudges';
  const state = await SchedulerState.findOne({ key: KEY }).lean();
  if (state?.last_run_date === ist.date) return;
  await SchedulerState.updateOne({ key: KEY }, { $set: { last_run_date: ist.date } }, { upsert: true });
  await require('../utils/studyNudges').sendStudyNudges().catch(err => console.warn('study nudges failed:', err.message));
}

async function _runStudyPlanTeacherDigestIfNeeded() {
  if (!(await NS.due('digest'))) return;
  const KEY = 'study_plan_teacher_weekly';
  const week = _isoWeekKey();
  const state = await SchedulerState.findOne({ key: KEY }).lean();
  if (state?.last_run_date === week) return;
  await SchedulerState.updateOne({ key: KEY }, { $set: { last_run_date: week } }, { upsert: true });
  await _sendStudyPlanTeacherDigest().catch(err => console.warn('study plan teacher digest failed:', err.message));
}

async function _runDailyJobsIfNeeded() {
  if (!(await NS.due('morning'))) return;   // was: the first tick of the (UTC) day, whenever that was
  const today = NS.ist().date;
  const KEY = 'daily_student_notifications';

  // Read-then-write, not atomic — a duplicate run in the rare case two
  // ticks land in the same instant is harmless (inactivity reminders dedupe
  // per-student via last_inactivity_reminder_at; a doubled motivation quote
  // once in a blue moon is not worth an upsert that would collide with the
  // unique `key` index every day after the first).
  const state = await SchedulerState.findOne({ key: KEY }).lean();
  if (state?.last_run_date === today) return; // already ran today

  await SchedulerState.updateOne({ key: KEY }, { $set: { last_run_date: today } }, { upsert: true });

  await Promise.all([
    _sendInactivityReminders().catch(err => console.warn('daily inactivity job failed:', err.message)),
    _sendDailyMotivation().catch(err => console.warn('daily motivation job failed:', err.message)),
    _sendStudyPlanMorningPush().catch(err => console.warn('study plan morning job failed:', err.message)),
  ]);
}

let _started = false;

function start() {
  if (_started) return;
  _started = true;

  setInterval(() => {
    _processExerciseQueue().catch(err => console.warn('exercise queue poll failed:', err.message));
    _sendPendingPaymentReminders().catch(err => console.warn('pending payment poll failed:', err.message));
    _runDailyJobsIfNeeded().catch(err => console.warn('daily jobs check failed:', err.message));
    _runStudyPlanEveningJobsIfNeeded().catch(err => console.warn('study plan evening check failed:', err.message));
    _runStudyPlanTeacherDigestIfNeeded().catch(err => console.warn('study plan teacher digest check failed:', err.message));
    _runGuestRemindersIfNeeded().catch(err => console.warn('guest reminders check failed:', err.message));
    _runStudyNudgesIfNeeded().catch(err => console.warn('study nudges check failed:', err.message));
    _runTeacherChatPushIfNeeded().catch(err => console.warn('teacher push check failed:', err.message));
    NS.runCustom().catch(err => console.warn('custom notifications failed:', err.message));
    // Weekly महा-Test: next week's test ready ahead of time; ranks once a window closes.
    const W = require('../utils/weeklyTests');
    W.ensureUpcoming().catch(err => console.warn('weekly ensure failed:', err.message));
    W.finalizeDue().catch(err => console.warn('weekly finalize failed:', err.message));
    // Paper Pattern Practice: 15-min reminder before each paper, marks / day result after it.
    W.notifyDue().catch(err => console.warn('practice notify failed:', err.message));
  }, QUEUE_POLL_MS);

  console.log('notificationScheduler: started (poll every', QUEUE_POLL_MS / 1000, 's)');
}

module.exports = { start, _internals: { _istNow, _runStudyPlanEveningJobsIfNeeded, _sendStudyPlanEveningJobs, _sendTeacherChatPush } };
