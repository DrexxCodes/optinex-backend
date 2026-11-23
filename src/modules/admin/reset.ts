import type { FastifyPluginAsync } from 'fastify';
import { isCasinoGame, type CasinoGameId } from '@/config/constants';
import { HttpError } from '@/lib/errors';
import { bodyOf } from '../helpers';
import { createResetLog } from './services/resetLog';
import { createResets } from './services/resets';

const CATEGORIES = ['financial', 'checkin', 'signup', 'game', 'referral', 'withdrawals'] as const;
type Category = (typeof CATEGORIES)[number];

// Which analytics fields belong to each category. Deliberately never includes the shared `total` /
// `amountTotal` counters — resetting one category must not erase another's history.
const CATEGORY_FIELDS: Record<'financial' | 'checkin' | 'signup', string[]> = {
  financial: ['revenueTotal', 'revenueEvents', 'counts.investment_submitted', 'counts.investment_verified', 'counts.account_upgrade_submitted', 'counts.account_upgrade_verified'],
  checkin: ['counts.checkin'],
  signup: ['counts.signup']
};

// Separate confirmation phrase for the nuke, a server-side backstop behind the UI's own modal.
const CONFIRM_PHRASE = 'DELETE EVERYTHING';

const resetRoutes: FastifyPluginAsync = async (app) => {
  const resets = createResets(app.c.db, app.c.redis);
  const log = createResetLog(app.c.config);

  app.get('/', async () => ({ resetLog: await log.get() }));

  app.post('/', async (req) => {
    const { category, gameId } = bodyOf(req);
    if (!CATEGORIES.includes(category)) throw new HttpError(400, `Category must be one of: ${CATEGORIES.join(', ')}.`);
    const c = category as Category;
    const validGameId: CasinoGameId | null = isCasinoGame(gameId) ? gameId : null;

    if (c === 'financial' || c === 'checkin' || c === 'signup') {
      await resets.analyticsFields(CATEGORY_FIELDS[c]);
      await log.record(c);
    } else if (c === 'game') {
      if (validGameId) {
        await resets.resetLeaderboard(validGameId);
        await log.recordGame(validGameId);
      } else {
        await resets.resetAllLeaderboards();
        await log.recordGame('all');
      }
    } else if (c === 'referral') {
      await resets.referralStats();
      await log.record('referral');
    } else if (c === 'withdrawals') {
      await resets.pendingWithdrawals();
      await log.record('withdrawals');
    }

    return { ok: true, category: c, gameId: validGameId, resetLog: await log.get() };
  });

  app.post('/nuke', async (req) => {
    if (bodyOf(req).confirm !== CONFIRM_PHRASE) throw new HttpError(400, 'Confirmation phrase did not match.');
    const result = await resets.nukeAllUsers();
    await log.record('nuke');
    return { ok: true, ...result, resetLog: await log.get() };
  });
};
export default resetRoutes;

