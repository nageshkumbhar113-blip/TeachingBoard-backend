const { decodeTokenFromHeader } = require('../utils/token');

function attachUserIfPresent(req, _res, next) {
  const payload = decodeTokenFromHeader(req.headers.authorization);
  if (payload) {
    req.user = payload;
  }
  next();
}

function requireAuth(req, res, next) {
  const payload = decodeTokenFromHeader(req.headers.authorization);
  if (!payload) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  req.user = payload;
  next();
}

function requireAdmin(req, res, next) {
  const payload = decodeTokenFromHeader(req.headers.authorization);
  if (!payload || payload.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  req.user = payload;
  next();
}

module.exports = { attachUserIfPresent, requireAuth, requireAdmin };
