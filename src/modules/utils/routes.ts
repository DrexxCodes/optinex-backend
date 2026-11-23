import type { FastifyPluginAsync } from 'fastify';
import { generateReference } from '@/lib/refGenerator';

// Thin wrapper around the shared reference generator (e.g. pre-filling a manual bank-transfer narration).
const utilRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.get('/ref-generator', async () => ({ reference: generateReference() }));
};
export default utilRoutes;
