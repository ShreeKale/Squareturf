/*
 * Small in-memory limiter: at most `max` requests per `windowMs` for each IP address.
 * Good enough for one server. Use a shared store (for example Redis) if you run several.
 */
function createRateLimiter({ windowMs, max, message = 'Too many attempts. Please try again in a few minutes.' }) {
  const hits = new Map();

  /* Forget old entries so the map does not grow forever */
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(req.ip, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ message });
    }

    next();
  };
}

module.exports = { createRateLimiter };