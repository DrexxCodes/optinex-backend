import type { Container } from '@/container';
import { REFERRAL_INCOME_RATE } from '@/config/constants';
import { REFERRAL_LEADERBOARD_KEY, REFERRAL_LEADERBOARD_NAMES_KEY, REFERRAL_WEEKLY_LEADERBOARD_KEY } from '@/config/redisKeys';
import { parseFlatScored, UUID_RE } from '@/lib/db/format';

export type ReferralLeaderboardEntry = {
  uid: string;
  fullName: string;
  username: string;
  weeklyReferrals: number;
  allTimeReferrals: number;
  weeklyIncome: number;
  allTimeIncome: number;
  rank: number;
};

const LEADERBOARD_LIMIT = 50;

export function createReferralWeekly({ db, redis, config }: Pick<Container, 'db' | 'redis' | 'config'>) {
  // Ranked by this week's referrals (Redis weekly zset); all-time from the never-reset zset. The
  // `profiles` columns remain the source of truth — Redis is a read cache.
  async function leaderboard(): Promise<ReferralLeaderboardEntry[]> {
    const top = parseFlatScored(await redis.zrange(REFERRAL_WEEKLY_LEADERBOARD_KEY, 0, LEADERBOARD_LIMIT - 1, { rev: true, withScores: true }));
    if (top.length === 0) return [];

    const uids = top.map((t) => t.member);
    const [names, allTimeScores] = await Promise.all([
      redis.hmget(REFERRAL_LEADERBOARD_NAMES_KEY, ...uids),
      Promise.all(uids.map((uid) => redis.zscore(REFERRAL_LEADERBOARD_KEY, uid)))
    ]);

    // Name cache is best-effort: anything missing falls back to the database in ONE query and backfills.
    const missingUids = uids.filter((uid) => {
      const cached = names?.[uid];
      if (!cached) return true;
      try {
        return !JSON.parse(cached).fullName;
      } catch {
        return true;
      }
    });

    const fetchedNames = new Map<string, { fullName: string; username: string }>();
    const lookupIds = missingUids.filter((id) => UUID_RE.test(id));
    if (lookupIds.length > 0) {
      const { data } = await db.from('profiles').select('id, full_name, username').in('id', lookupIds);
      for (const r of data ?? []) fetchedNames.set(r.id, { fullName: r.full_name || 'Incossify user', username: r.username ?? '' });
      if (fetchedNames.size > 0) {
        try {
          const payload: Record<string, string> = {};
          for (const [uid, entry] of fetchedNames) payload[uid] = JSON.stringify(entry);
          await redis.hset(REFERRAL_LEADERBOARD_NAMES_KEY, payload);
        } catch (err) {
          console.error('[admin/referrals] name cache backfill failed:', err);
        }
      }
    }

    return top.map((entry, i) => {
      let fullName = 'Incossify user';
      let username = '';
      const cached = names?.[entry.member];
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed.fullName) {
            fullName = parsed.fullName;
            username = parsed.username ?? username;
          }
        } catch {
          // ignore malformed cache entries
        }
      }
      const fetched = fetchedNames.get(entry.member);
      if (fetched) {
        fullName = fetched.fullName;
        username = fetched.username;
      }

      const weeklyReferrals = entry.score;
      const allTimeReferrals = Number(allTimeScores[i] ?? 0);
      return {
        uid: entry.member,
        fullName,
        username,
        weeklyReferrals,
        allTimeReferrals,
        weeklyIncome: weeklyReferrals * REFERRAL_INCOME_RATE,
        allTimeIncome: allTimeReferrals * REFERRAL_INCOME_RATE,
        rank: i + 1
      };
    });
  }

  async function lastReset(): Promise<string | null> {
    const value = await config.get<{ lastReset?: string }>('referralWeekly');
    return value?.lastReset ? new Date(value.lastReset).toISOString() : null;
  }

  // Zeroes every user's *weekly* count only — never all-time, earnings or wallet.
  async function resetWeekly(): Promise<{ cleared: number }> {
    const { data, error } = await db.rpc('reset_weekly_referrals');
    if (error) throw new Error(error.message);
    await redis.del(REFERRAL_WEEKLY_LEADERBOARD_KEY);
    await config.merge('referralWeekly', { lastReset: new Date().toISOString() });
    return { cleared: Number(data ?? 0) };
  }

  return { leaderboard, lastReset, resetWeekly };
}
