import type { FastifyPluginAsync } from 'fastify';
import overview from './overview';
import users from './users';
import investments from './investments';
import loans from './loans';
import withdrawals from './withdrawals';
import upgrade from './upgrade';
import tasks from './tasks';
import popup from './popup';
import push from './push';
import leaderboard from './leaderboard';
import referrals from './referrals';
import reset from './reset';

// Everything under /api/admin is behind requireAdmin (live `is_admin` check) — one hook, impossible to forget.
const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAdmin);

  await app.register(overview, { prefix: '/overview' });
  await app.register(users, { prefix: '/users' });
  await app.register(investments, { prefix: '/investments' });
  await app.register(loans, { prefix: '/loans' });
  await app.register(withdrawals, { prefix: '/withdrawals' });
  await app.register(upgrade, { prefix: '/upgrade' });
  await app.register(tasks, { prefix: '/tasks' });
  await app.register(popup, { prefix: '/popup' });
  await app.register(push, { prefix: '/push' });
  await app.register(leaderboard, { prefix: '/leaderboard' });
  await app.register(referrals, { prefix: '/referrals' });
  await app.register(reset, { prefix: '/reset' });
};
export default adminRoutes;
