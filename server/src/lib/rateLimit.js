/**
 * Fixed-window in-memory rate limiter (single Render instance).
 * hit(key) → { ok, remaining, retryAfter } ; entries expire automatically.
 */
export function createRateLimiter({ limit, windowMs, clock = Date.now, maxKeys = 50000 }) {
  const buckets = new Map();

  function sweep(now) {
    for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
  }

  return {
    hit(key) {
      const now = clock();
      let b = buckets.get(key);
      if (!b || b.reset <= now) {
        if (buckets.size >= maxKeys) sweep(now);
        b = { count: 0, reset: now + windowMs };
        buckets.set(key, b);
      }
      b.count += 1;
      const ok = b.count <= limit;
      return { ok, remaining: Math.max(0, limit - b.count), retryAfter: ok ? 0 : Math.ceil((b.reset - now) / 1000) };
    },
    peek(key) {
      const b = buckets.get(key);
      return b && b.reset > clock() ? b.count : 0;
    },
    reset(key) {
      buckets.delete(key);
    },
  };
}
