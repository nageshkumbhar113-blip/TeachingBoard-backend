/**
 * In-process scheduler for student push notifications that can't fire
 * synchronously from a single request:
 *   1. Debounced "new Exercise questions" pushes (many publish calls → one push)
 *   2. Daily "haven't studied in N days" reminder
 *   3. Daily motivation quote
 *
 * No external cron service — this project has none configured — so it's a
 * plain setInterval as long as the Node process stays up, same tradeoff
 * every other in-process feature here already makes. Call start() once from
 * app.js after the DB connects.
 */

const User = require('../models/User');
const StudentProgress = require('../models/StudentProgress');
const NotificationQueue = require('../models/NotificationQueue');
const SchedulerState = require('../models/SchedulerState');
const DefaultBannerQuote = require('../models/DefaultBannerQuote');
const { notifyBatch } = require('../utils/studentNotify');
const { sendToMany } = require('../utils/fcm');

const QUEUE_POLL_MS   = 5 * 60 * 1000;   // check the debounce queue every 5 min
const QUEUE_QUIET_MS  = 2 * 60 * 1000;   // ...but only send once a batch/chapter has been quiet 2 min
const INACTIVITY_DAYS = 3;               // configurable per the confirmed 3-day reminder

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
  }).select('device_token').lean();
  const tokens = [...new Set(students.map(s => s.device_token).filter(Boolean))];
  if (!tokens.length) return;

  await sendToMany(tokens, '✨ आजचा विचार', quote, { type: 'daily_motivation' }).catch(err =>
    console.warn('daily motivation send failed:', err.message)
  );
}

async function _runDailyJobsIfNeeded() {
  const today = _todayStr();
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
  ]);
}

let _started = false;

function start() {
  if (_started) return;
  _started = true;

  setInterval(() => {
    _processExerciseQueue().catch(err => console.warn('exercise queue poll failed:', err.message));
    _runDailyJobsIfNeeded().catch(err => console.warn('daily jobs check failed:', err.message));
  }, QUEUE_POLL_MS);

  console.log('notificationScheduler: started (poll every', QUEUE_POLL_MS / 1000, 's)');
}

module.exports = { start };
