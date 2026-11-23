import type { FastifyPluginAsync } from 'fastify';
import { isCasinoGame, type CasinoGameId } from '@/config/constants';
import { gameLeaderboardKey, gameLeaderboardNamesKey } from '@/config/redisKeys';
import { parseFlatScored } from '@/lib/db/format';
import { queryOf } from '../helpers';

const PAGE_SIZE = 10;

// Paginated per-game leaderboard. Pulls PAGE_SIZE (+1 to detect a next page) per request from Redis.
const leaderboardAdminRoutes: FastifyPluginAsync = async (app) => {
  const { redis } = app.c;

  app.get('/', async (req) => {
    const q = queryOf(req);
    const gameId: CasinoGameId = isCasinoGame(q.game) ? q.game : 'brick-slasher';
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);

    const all = parseFlatScored(await redis.zrange(gameLeaderboardKey(gameId), offset, offset + PAGE_SIZE, { rev: true, withScores: true }));
    const hasMore = all.length > PAGE_SIZE;
    const page = all.slice(0, PAGE_SIZE);

    const uids = page.map((e) => e.member);
    const usernames = uids.length ? await redis.hmget(gameLeaderboardNamesKey(gameId), ...uids) : {};

    return {
      entries: page.map((e, i) => ({ rank: offset + i + 1, uid: e.member, username: usernames?.[e.member] ?? 'Unknown', score: e.score })),
      hasMore,
      offset,
      game: gameId
    };
  });
};
export default leaderboardAdminRoutes;
