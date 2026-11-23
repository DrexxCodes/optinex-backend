import type { FastifyPluginAsync } from 'fastify';
import { queryOf } from '../helpers';

const walletRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/transactions', async (req) => {
    const q = queryOf(req);
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 50);
    return app.c.wallet.list(req.session!.uid, limit, q.cursor ?? null);
  });
};
export default walletRoutes;
