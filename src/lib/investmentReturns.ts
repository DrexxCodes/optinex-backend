// Daily investment returns — runs inline whenever a user logs in (or their session is refreshed).
//   1. Bail out fast if they're on the Free plan or have no package.
//   2. Package price -> 10%/day return amount.
//   3. Find where we left off — Redis first; else `last_investment_return_at` / `package_started_at`.
//   4. Credit one wallet transaction per missed day, capped at MAX_BACKLOG_DAYS and the package expiry.
//   5. If the package has expired, flip the user back to the Free plan.
import type { Db, Row } from './db/types';
import type { RedisLike } from './clients/redis';
import { lastReturnCacheKey } from '@/config/redisKeys';

const DAILY_RETURN_PERCENTAGE = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_BACKLOG_DAYS = 10;

export type SyncResult =
  | { status: 'no-package' }
  | { status: 'up-to-date' }
  | { status: 'credited'; days: number; totalCredited: number }
  | { status: 'expired'; daysCredited: number; totalCredited: number };

export function createInvestmentSync(db: Db, redis: RedisLike) {
  const cacheGet = async <T>(key: string): Promise<T | null> => {
    try {
      return (await redis.get<T>(key)) ?? null;
    } catch (err) {
      console.error(`[redis] cacheGet failed for "${key}":`, err);
      return null;
    }
  };
  const cacheSet = async (key: string, value: unknown, ttl: number) => {
    try {
      await redis.set(key, value, { ex: ttl });
    } catch (err) {
      console.error(`[redis] cacheSet failed for "${key}":`, err);
    }
  };

  /** `preloadedUser` is the caller's already-fetched `profiles` row — pass it to skip a second read. */
  return async function syncInvestmentOnLogin(uid: string, preloadedUser?: Row): Promise<SyncResult> {
    let user: Row;
    if (preloadedUser) {
      user = preloadedUser;
    } else {
      const { data } = await db.from('profiles').select('*').eq('id', uid).maybeSingle();
      if (!data) return { status: 'no-package' };
      user = data;
    }

    if (!user.package_id || user.package_status === 'Free') return { status: 'no-package' };

    const { data: pkg } = await db.from('packages').select('price').eq('id', user.package_id).maybeSingle();
    if (!pkg) return { status: 'no-package' };

    const cost = Number(pkg.price ?? 0);
    const dailyReturn = Math.round(((cost * DAILY_RETURN_PERCENTAGE) / 100) * 100) / 100;
    if (dailyReturn <= 0) return { status: 'no-package' };

    const now = Date.now();
    const expiresAt: number | null = user.package_expires_at ?? null;
    const isExpired = expiresAt !== null && now >= expiresAt;
    const effectiveEnd = expiresAt !== null ? Math.min(now, expiresAt) : now;

    const cachedLast = await cacheGet<number>(lastReturnCacheKey(uid));
    let lastReturnAt: number;
    if (cachedLast != null) {
      lastReturnAt = cachedLast;
    } else {
      lastReturnAt = user.last_investment_return_at ?? user.package_started_at ?? now;
      await cacheSet(lastReturnCacheKey(uid), lastReturnAt, CACHE_TTL_SECONDS);
    }

    let daysElapsed = Math.floor((effectiveEnd - lastReturnAt) / MS_PER_DAY);
    if (daysElapsed > MAX_BACKLOG_DAYS) {
      lastReturnAt += (daysElapsed - MAX_BACKLOG_DAYS) * MS_PER_DAY;
      daysElapsed = MAX_BACKLOG_DAYS;
    }

    let totalCredited = 0;

    if (daysElapsed > 0) {
      // One atomic Postgres call writes every backlog entry + the wallet bump + the cursor.
      const { data, error } = await db.rpc('credit_investment_returns', {
        p_user: uid,
        p_days: daysElapsed,
        p_daily: dailyReturn,
        p_last_ms: Math.round(lastReturnAt),
        p_package_id: user.package_id
      });
      if (error) throw new Error(error.message);

      totalCredited = Number(data ?? Math.round(dailyReturn * daysElapsed * 100) / 100);
      await cacheSet(lastReturnCacheKey(uid), lastReturnAt + daysElapsed * MS_PER_DAY, CACHE_TTL_SECONDS);
    }

    if (isExpired) {
      const { error } = await db.rpc('expire_package', { p_user: uid });
      if (error) throw new Error(error.message);
      return { status: 'expired', daysCredited: daysElapsed, totalCredited };
    }

    return daysElapsed > 0 ? { status: 'credited', days: daysElapsed, totalCredited } : { status: 'up-to-date' };
  };
}
export type InvestmentSync = ReturnType<typeof createInvestmentSync>;
