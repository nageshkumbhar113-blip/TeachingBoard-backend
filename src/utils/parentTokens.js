/**
 * Push tokens of every parent of the given students.
 *
 * A parent reaches the Parent view in two ways (see authController login):
 *   • a real Parent account (role 'parent', children: [codes]) → its device_token
 *   • the child's own code+PIN (the common case, no Parent account) → that
 *     session's token is stored on the STUDENT document as parent_device_token
 * Every "notify the parents" send must use this helper so both kinds of
 * parent are reached — previously only the first kind was.
 */
const User = require('../models/User');

const _has = { $exists: true, $nin: [null, ''] };

async function parentTokensFor(studentCodes) {
  const codes = [...new Set((studentCodes || []).map(c => String(c || '').trim().toUpperCase()).filter(Boolean))];
  if (!codes.length) return [];
  const [parents, viaStudent] = await Promise.all([
    User.find({ role: 'parent', children: { $in: codes }, device_token: _has }).select('device_token').lean(),
    User.find({ role: 'student', student_code: { $in: codes }, parent_device_token: _has }).select('parent_device_token').lean(),
  ]);
  return [...new Set([
    ...parents.map(p => p.device_token),
    ...viaStudent.map(s => s.parent_device_token),
  ].filter(Boolean))];
}

module.exports = { parentTokensFor };
