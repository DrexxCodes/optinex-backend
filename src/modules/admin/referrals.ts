import type { FastifyPluginAsync } from 'fastify';
import { createReferralWeekly } from './services/referralWeekly';

const referralAdminRoutes: FastifyPluginAsync = async (app) => {
  const weekly = createReferralWeekly(app.c);

  app.get('/', async () => {
    const [leaderboard, lastReset] = await Promise.all([weekly.leaderboard(), weekly.lastReset()]);
    return { leaderboard, lastReset };
  });

  app.post('/reset', async () => {
    const { cleared } = await weekly.resetWeekly();
    return { ok: true, cleared, lastReset: await weekly.lastReset() };
  });
};
export default referralAdminRoutes;
