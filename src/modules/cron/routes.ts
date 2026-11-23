import type { FastifyPluginAsync } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from '@/lib/errors';

// LEGACY: flat 2% daily return, meant for an external monitor (Better Stack). The real return logic runs
// inline at login (10%/day) — running both pays twice, so only schedule this if that is genuinely intended.
// Unlike the Next.js version there is NO localhost bypass: behind a same-host proxy every request would
// look local. CRON_SECRET (Bearer) is the only way in.
const cronRoutes: FastifyPluginAsync = async (app) => {
  const { env, db } = app.c;

  const digest = (s: string) => createHash('sha256').update(s).digest();
  const authorize = (header: string | undefined) => {
    if (!env.CRON_SECRET || !header) throw new HttpError(401, 'Unauthorized.');
    if (!timingSafeEqual(digest(header), digest(`Bearer ${env.CRON_SECRET}`))) throw new HttpError(401, 'Unauthorized.');
  };

  app.post('/investment-returns', async (req) => {
    authorize(req.headers.authorization);

    try {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const todayString = today.toISOString().split('T')[0];

      // One set-based Postgres call: every non-Free user with an active investment who hasn't received
      // today's 2% yet gets the legacy transaction + wallet bump.
      const { data, error } = await db.rpc('legacy_investment_cron', { p_today: todayString });
      if (error) throw new Error(error.message);

      const processed = data?.processed ?? 0;
      const errors = data?.errors ?? 0;
      return { success: true, processed, errors, message: `Processed ${processed} users, ${errors} errors` };
    } catch (error) {
      console.error('Investment returns cron error:', error);
      throw new HttpError(500, 'Internal server error', { details: String(error) });
    }
  });

  app.get('/investment-returns', async (req) => {
    authorize(req.headers.authorization);
    return {
      status: 'ok',
      message: 'Use POST to trigger investment returns distribution',
      documentation: {
        endpoint: '/api/cron/investment-returns',
        method: 'POST',
        headers: { authorization: 'Bearer YOUR_CRON_SECRET' },
        description: 'Distributes 2% daily returns to users with active investment packages'
      }
    };
  });
};
export default cronRoutes;
