const { decodeTokenFromHeader } = require('../utils/token');
const User = require('../models/User');
const YoutubeTeacherPartner = require('../models/YoutubeTeacherPartner');
const { isExpiredDate } = require('../utils/accountStatus');

// 60-second in-memory cache — avoids DB hit on every API request.
// Max 200 entries; stale entries evicted lazily on insert.
const _userCache = new Map();
const _CACHE_TTL = 60_000;

function _studentDenial(userDoc) {
  if (!userDoc || userDoc.role !== 'student') return null;
  if (userDoc.status === 'blocked') {
    return { message: 'Student access is blocked', code: 'ACCOUNT_BLOCKED' };
  }

  // An expired student is no longer locked out: they fall back to the free
  // tier (free chapters only), enforced per-item by utils/contentAccess.js.
  return null;
}

// Drop a cached user doc right after a payment / admin change so the new
// access level applies immediately instead of after the 60s cache TTL.
function invalidateUserCache(role, id) {
  _userCache.delete(`${role}:${id}`);
}

async function _attachResolvedUser(req) {
  const payload = decodeTokenFromHeader(req.headers.authorization);
  if (!payload) return null;

  req.user = payload;

  const now = Date.now();
  const cacheKey = `${payload.role}:${payload.id}`;
  const hit = _userCache.get(cacheKey);
  if (hit && (now - hit.at) < _CACHE_TTL) {
    req.userDoc = hit.doc;
    return payload;
  }

  // youtube_teacher is a separate identity collection (own registration,
  // not the existing User model) — look it up by _id, not user_id.
  const userDoc = payload.role === 'youtube_teacher'
    ? await YoutubeTeacherPartner.findById(payload.id).lean().catch(() => null)
    : await User.findOne({ user_id: payload.id }).lean().catch(() => null);

  if (userDoc) {
    req.userDoc = userDoc;
    _userCache.set(cacheKey, { doc: userDoc, at: now });
    if (_userCache.size > 200) {
      for (const [k, v] of _userCache) {
        if (now - v.at > _CACHE_TTL) _userCache.delete(k);
      }
    }
  }
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
  if (!payload) return res.status(401).json({ success: false, message: 'Authentication required' });
  if (payload.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin access required' });
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

// A teacher account that is pending approval, or blocked, has no API access.
function _teacherDenied(req, res) {
  const st = req.userDoc?.status;
  if (req.userDoc?.validity_until && isExpiredDate(req.userDoc.validity_until)) {
    res.status(403).json({
      success: false,
      message: 'Your validity period has ended. Please contact the admin to renew.',
      code: 'TEACHER_VALIDITY_ENDED',
    });
    return true;
  }
  if (st === 'pending' || st === 'blocked') {
    res.status(403).json({
      success: false,
      message: st === 'pending' ? 'Your registration is waiting for admin approval.' : 'This teacher account is blocked.',
      code: st === 'pending' ? 'ACCOUNT_PENDING' : 'ACCOUNT_BLOCKED',
    });
    return true;
  }
  return false;
}

// A YouTube partner earns commission but must not see student data or use teacher tools.
// Only the partner (earnings) endpoints and device-token registration stay open to them.
function _youtubePartnerBlocked(req, res) {
  if (req.userDoc?.partner_type !== 'youtube') return false;
  const url = String(req.originalUrl || '');
  if (url.startsWith('/api/partners/') || url.startsWith('/api/teacher/device-token')) return false;
  res.status(403).json({ success: false, code: 'PARTNER_NO_ACCESS', message: 'This feature is not available for YouTube partner accounts.' });
  return true;
}

async function requireTeacher(req, res, next) {
  const payload = await _attachResolvedUser(req);
  if (!payload) return res.status(401).json({ success: false, message: 'Authentication required' });
  if (payload.role !== 'teacher') return res.status(403).json({ success: false, message: 'Teacher access required' });
  if (_teacherDenied(req, res)) return;
  if (_youtubePartnerBlocked(req, res)) return;
  next();
}

async function requireParent(req, res, next) {
  const payload = await _attachResolvedUser(req);
  if (!payload) return res.status(401).json({ success: false, message: 'Authentication required' });
  if (payload.role !== 'parent') return res.status(403).json({ success: false, message: 'Parent access required' });
  next();
}

async function requireTeacherOrAdmin(req, res, next) {
  const payload = await _attachResolvedUser(req);
  if (!payload || !['teacher', 'admin'].includes(payload.role)) {
    return res.status(403).json({ success: false, message: 'Teacher or admin access required' });
  }
  if (payload.role === 'teacher' && _teacherDenied(req, res)) return;
  if (payload.role === 'teacher' && _youtubePartnerBlocked(req, res)) return;
  next();
}

// YouTube Teacher Partner — external content-creator teacher, separate
// identity from the in-app 'teacher' role above (see YoutubeTeacherPartner
// model). req.user.id is the partner's Mongo _id (string).
async function requireYoutubeTeacher(req, res, next) {
  const payload = await _attachResolvedUser(req);
  if (!payload || payload.role !== 'youtube_teacher') {
    return res.status(401).json({ success: false, message: 'YouTube teacher login required' });
  }
  if (!req.userDoc || req.userDoc.status !== 'active') {
    return res.status(403).json({ success: false, message: 'Account is not active', code: 'ACCOUNT_INACTIVE' });
  }
  next();
}

module.exports = {
  invalidateUserCache,
  attachUserIfPresent,
  requireAuth,
  requireAdmin,
  requireStudent,
  requireTeacher,
  requireParent,
  requireTeacherOrAdmin,
  requireYoutubeTeacher,
};
