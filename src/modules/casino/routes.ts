import type { FastifyPluginAsync } from 'fastify';
import { isCasinoGame, type CasinoGameId } from '@/config/constants';
import { gameLeaderboardKey, gameLeaderboardNamesKey } from '@/config/redisKeys';
import { HttpError } from '@/lib/errors';
import { parseFlatScored } from '@/lib/db/format';
import { bodyOf, queryOf } from '../helpers';

const casinoRoutes: FastifyPluginAsync = async (app) => {
  const { db, redis, analytics } = app.c;
  app.addHook('preHandler', app.authenticate);

  // Top 10 for one game, read entirely from Redis. Only `username` and `score` are ever returned.
  app.get('/leaderboard', async (req) => {
    const gameParam = queryOf(req).game;
    const gameId: CasinoGameId = isCasinoGame(gameParam) ? gameParam : 'brick-slasher';

    const top = parseFlatScored(await redis.zrange(gameLeaderboardKey(gameId), 0, 9, { rev: true, withScores: true }));
    const uids = top.map((e) => e.member);
    const usernames = uids.length ? await redis.hmget(gameLeaderboardNamesKey(gameId), ...uids) : {};

    return {
      leaderboard: top.map((e, i) => ({ rank: i + 1, username: usernames?.[e.member] ?? 'Player', score: e.score }))
    };
  });

  app.post('/submit-score', async (req) => {
    const session = req.session!;
    const { score, game } = bodyOf(req);
    if (typeof score !== 'number' || score < 0) throw new HttpError(400, 'Invalid score.');
    // Default to brick-slasher so any not-yet-updated client keeps working.
    const gameId: CasinoGameId = isCasinoGame(game) ? game : 'brick-slasher';

    const leaderboardKey = gameLeaderboardKey(gameId);
    const existing = await redis.zscore(leaderboardKey, session.uid);
    if (existing === null || score > Number(existing)) {
      await Promise.all([
        redis.zadd(leaderboardKey, { score, member: session.uid }),
        redis.hset(gameLeaderboardNamesKey(gameId), { [session.uid]: session.username })
      ]);
      // The profile's high score only changes when the leaderboard score does — skip the DB write otherwise.
      await db.rpc('set_casino_high_score', { p_user: session.uid, p_game: gameId, p_score: score });
    }

    await analytics.safeLog('casino_score_submitted', score, 'casino');
    return { ok: true };
  });
};
export default casinoRoutes;
