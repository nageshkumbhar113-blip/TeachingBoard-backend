/**
 * Push-notify students directly (new content, study reminders, etc).
 * Separate from notificationController.js's teacher→parent flow — this
 * targets students' own device tokens (registered via
 * PATCH /api/student/device-token, see studentController.updateOwnDeviceToken).
 */

const User = require('../models/User');
const { sendToMany } = require('./fcm');

/**
 * Push every student assigned to `batchName` who has a device token.
 * Silently no-ops if nobody matches or FCM isn't configured.
 */
async function notifyBatch(batchName, title, body, data = {}) {
  const batch = String(batchName || '').trim();
  if (!batch) return;

  const students = await User.find({
    role: 'student',
    assigned_batches: batch,
    device_token: { $exists: true, $nin: [null, ''] },
  }).select('device_token').lean();

  const tokens = [...new Set(students.map(s => s.device_token).filter(Boolean))];
  if (!tokens.length) return;

  await sendToMany(tokens, title, body, data).catch(err =>
    console.warn('notifyBatch sendToMany partial failure:', err.message)
  );
}

/** Push one student (by user_id). Silently no-ops without a device token / FCM. */
async function notifyStudent(userId, title, body, data = {}) {
  try {
    const s = await User.findOne({ role: 'student', user_id: userId }).select('device_token').lean();
    if (!s || !s.device_token) return;
    await sendToMany([s.device_token], title, body, data);
  } catch (err) {
    console.warn('notifyStudent failed:', err.message);
  }
}

module.exports = { notifyBatch, notifyStudent };
