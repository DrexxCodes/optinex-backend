// Destructive admin resets. Each one is a single atomic Postgres function plus the matching Redis cleanup.
import type { Db } from '@/lib/db/types';
import type { RedisLike } from '@/lib/clients/redis';
import { CASINO_GAME_IDS, type CasinoGameId } from '@/config/constants';
import {
  gameLeaderboardKey,
  gameLeaderboardNamesKey,
  REFERRAL_LEADERBOARD_KEY,
  REFERRAL_LEADERBOARD_NAMES_KEY,
  REFERRAL_WEEKLY_LEADERBOARD_KEY
} from '@/config/redisKeys';
import { UUID_RE } from '@/lib/db/format';

export function createResets(db: Db, redis: RedisLike) {
  async function resetLeaderboard(gameId: CasinoGameId): Promise<{ clearedCount: number }> {
    const uids = (await redis.zrange(gameLeaderboardKey(gameId), 0, -1)).map(String);
    await Promise.all([redis.del(gameLeaderboardKey(gameId)), redis.del(gameLeaderboardNamesKey(gameId))]);

    const ids = uids.filter((id) => UUID_RE.test(id));
    if (ids.length) {
      const { error } = await db.rpc('reset_game_scores', { p_game: gameId, p_ids: ids });
      if (error) throw new Error(error.message);
    }
    return { clearedCount: uids.length };
  }

  return {
    // Zeroes specific analytics fields across every daily / monthly / yearly row. Field-scoped on purpose:
    // `total`/`amount_total` are shared counters, so resetting one category must never touch them.
    async analyticsFields(fields: string[]) {
      const { error } = await db.rpc('reset_analytics_fields', { p_fields: fields });
      if (error) throw new Error(error.message);
    },

    resetLeaderboard,

    async resetAllLeaderboards(): Promise<{ clearedCount: number }> {
      let total = 0;
      for (const gameId of CASINO_GAME_IDS) total += (await resetLeaderboard(gameId)).clearedCount;
      return { clearedCount: total };
    },

    // Clears referral links/earnings/weekly+all-time counts and both Redis boards. Never touches wallet_amount.
    async referralStats(): Promise<{ clearedLinks: number; clearedEarnings: number }> {
      const { data, error } = await db.rpc('reset_referral_stats');
      if (error) throw new Error(error.message);
      await Promise.all([redis.del(REFERRAL_LEADERBOARD_KEY), redis.del(REFERRAL_WEEKLY_LEADERBOARD_KEY), redis.del(REFERRAL_LEADERBOARD_NAMES_KEY)]);
      return { clearedLinks: data?.clearedLinks ?? 0, clearedEarnings: data?.clearedEarnings ?? 0 };
    },

    // Voids pending withdrawals and refunds the already-debited wallet amount (marked 'reset', not 'failed').
    async pendingWithdrawals(): Promise<{ clearedCount: number }> {
      const { data, error } = await db.rpc('reset_pending_withdrawals');
      if (error) throw new Error(error.message);
      return { clearedCount: Number(data ?? 0) };
    },

    // The big red button: every non-admin user and all money records. Admins are preserved on purpose.
    async nukeAllUsers() {
      const { data, error } = await db.rpc('nuke_all_users');
      if (error) throw new Error(error.message);

      const keys = [
        ...CASINO_GAME_IDS.flatMap((id) => [gameLeaderboardKey(id), gameLeaderboardNamesKey(id)]),
        REFERRAL_LEADERBOARD_KEY,
        REFERRAL_WEEKLY_LEADERBOARD_KEY,
        REFERRAL_LEADERBOARD_NAMES_KEY
      ];
      await Promise.all(keys.map((k) => redis.del(k)));

      return {
        usersDeleted: data?.usersDeleted ?? 0,
        adminsPreserved: data?.adminsPreserved ?? 0,
        authUsersDeleted: data?.authUsersDeleted ?? 0
      };
    }
  };
}
