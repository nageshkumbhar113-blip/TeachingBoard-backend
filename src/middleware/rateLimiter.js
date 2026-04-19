// Simple in-memory rate limiter — no external dependency
// Resets on process restart (acceptable for Render's single-instance deployment)

function createRateLimiter({ windowMs = 60_000, max = 20, message = 'Too many requests' } = {}) {
  const store = new Map();

  // Prune stale entries to prevent memory leak
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of store.entries()) {
      if (entry.start < cutoff) store.delete(key);
    }
  }, windowMs).unref();

  return function rateLimiterMiddleware(req, res, next) {
    const key = req.ip
      || req.headers['x-forwarded-for']?.split(',')[0].trim()
      || 'unknown';

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
