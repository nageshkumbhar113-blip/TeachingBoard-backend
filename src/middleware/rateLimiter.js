// Simple in-memory rate limiter — no external dependency
// Resets on process restart (acceptable for Render's single-instance deployment)

// `keyFn(req)` (optional) buckets by something other than the client IP, e.g. an
// account code; returning '' skips limiting for that request. `skip(req)`
// (optional) bypasses this limiter entirely. Both default to the old IP-only
// behaviour.
function createRateLimiter({ windowMs = 60_000, max = 20, message = 'Too many requests', keyFn = null, skip = null } = {}) {
  const store = new Map();

  // Prune stale entries to prevent memory leak
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of store.entries()) {
      if (entry.start < cutoff) store.delete(key);
    }
  }, windowMs).unref();

  return function rateLimiterMiddleware(req, res, next) {
    if (skip && skip(req)) return next();
    const key = keyFn
      ? keyFn(req)
      : (req.ip
        || req.headers['x-forwarded-for']?.split(',')[0].trim()
        || 'unknown');
    if (!key) return next();

    const now  = Date.now();
    const entry = store.get(key);

    if (!entry || now - entry.start > windowMs) {
      store.set(key, { count: 1, start: now });
      return next();
    }

    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ success: false, message });
    }

    next();
  };
}

module.exports = { createRateLimiter };
