const { decodeTokenFromHeader } = require('../utils/token');
const User = require('../models/User');
const { isExpiredDate, normalizeExpiryDate } = require('../utils/accountStatus');

function _studentDenial(userDoc) {
  if (!userDoc || userDoc.role !== 'student') return null;
  if (userDoc.status === 'blocked') {
    return { message: 'Student access is blocked', code: 'ACCOUNT_BLOCKED' };
  }

  const expiryDate = normalizeExpiryDate(userDoc.expiry_date);
  if (expiryDate && isExpiredDate(expiryDate)) {
    return { message: 'Student access expired', code: 'ACCOUNT_EXPIRED', expiryDate };
  }

  return null;
}

async function _attachResolvedUser(req) {
  const payload = decodeTokenFromHeader(req.headers.authorization);
  if (!payload) return null;

  req.user = payload;
  const userDoc = await User.findOne({ user_id: payload.id }).lean().catch(() => null);
  if (userDoc) req.userDoc = userDoc;
  return payload;
}

async function attachUserIfPresent(req, _res, next) {
  await _attachResolvedUser(req);
  req.authDenied = _studentDenial(req.userDoc);
  next();
}

async function requireAuth(req, res, next) {
  const payload = await _attachResolvedUser(req);
  if (!payload) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

async function requireAdmin(req, res, next) {
  const payload = await _attachResolvedUser(req);
  if (!payload || payload.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
}

async function requireStudent(req, res, next) {
  const payload = await _attachResolvedUser(req);
  if (!payload || payload.role !== 'student') {
    return res.status(401).json({ success: false, message: 'Student login required' });
  }

  const denial = _studentDenial(req.userDoc);
  if (denial) {
    return res.status(403).json({
      success: false,
      message: denial.message,
      code: denial.code,
      expiryDate: denial.expiryDate || '',
    });
  }

  next();
}

module.exports = { attachUserIfPresent, requireAuth, requireAdmin, requireStudent };
