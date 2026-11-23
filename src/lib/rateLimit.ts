import type { RedisLike } from './clients/redis';

// Fixed-window limiter on Redis, keyed per user. Fails open if Redis is unreachable so an outage never
// locks users out (same behaviour as the Next.js apps).
export function createRedisLimiter(redis: RedisLike) {
  return async function rateLimit(name: string, id: string, limit: number, windowSeconds: number) {
    const windowId = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `rl:${name}:${id}:${windowId}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSeconds);
      const retryAfter = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
      return { allowed: count <= limit, retryAfter };
    } catch (err) {
      console.error('[rateLimit] check failed, failing open:', err);
      return { allowed: true, retryAfter: 0 };
    }
  };
}
export type RedisLimiter = ReturnType<typeof createRedisLimiter>;

// In-process fixed-window limiter — zero network cost. Valid because the backend runs as a single
// server/container; use the Redis limiter above for limits that must survive restarts.
export function createMemoryLimiter(opts: { max: number; windowMs: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(10_000, opts.windowMs));
  sweep.unref();

  return {
    hit(key: string) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + opts.windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return { allowed: entry.count <= opts.max, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    },
    stop: () => clearInterval(sweep)
  };
}
export type MemoryLimiter = ReturnType<typeof createMemoryLimiter>;
