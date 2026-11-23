import type { FastifyPluginAsync } from 'fastify';
import { CHECKIN_REWARD } from '@/config/constants';
import { MAX_DAILY_SPINS, pickWeightedPrize } from '@/config/prizes';
import { HttpError, conflict, notFound } from '@/lib/errors';
import { generateReference } from '@/lib/refGenerator';
import { iso, rpcMessage } from '@/lib/db/format';

const CYCLE_MS = 1000 * 60 * 60 * 24;

const streakRoutes: FastifyPluginAsync = async (app) => {
  const { db, analytics } = app.c;
  app.addHook('preHandler', app.authenticate);

  app.post('/checkin', async (req) => {
    // The 24h cooldown check, check-in row, wallet credit and streak bump are one atomic Postgres call.
    const { data, error } = await db.rpc('daily_checkin', { p_user: req.session!.uid, p_reward: CHECKIN_REWARD, p_ref: generateReference() });
    if (error) {
      console.error('[streak/checkin]', error);
      throw new HttpError(500, 'Could not process check-in.');
    }
    if (data.already) throw conflict('Already checked in.', { nextAvailableAt: data.next_available_at });

    await analytics.safeLog('checkin', CHECKIN_REWARD, 'streak/checkin');
    return { ok: true, reward: data.reward, txnRef: data.txn_ref };
  });

  app.get('/history', async (req) => {
    const uid = req.session!.uid;
    const [profile, checkins] = await Promise.all([
      db.from('profiles').select('last_checkin_at, streak_count').eq('id', uid).maybeSingle(),
      db.from('checkins').select('id, date, created_at').eq('user_id', uid).order('id', { ascending: false }).limit(30)
    ]);

    const user = profile.data;
    const lastCheckinAt = user?.last_checkin_at ? new Date(user.last_checkin_at) : undefined;
    const now = new Date();
    const canCheckIn = !lastCheckinAt || now.getTime() - lastCheckinAt.getTime() >= CYCLE_MS;
    const nextAvailableAt = lastCheckinAt ? new Date(lastCheckinAt.getTime() + CYCLE_MS) : null;

    return {
      canCheckIn,
      nextAvailableAt,
      streakCount: user?.streak_count ?? 0,
      history: (checkins.data ?? []).map((c: any) => ({ id: String(c.id), date: c.date, timestamp: iso(c.created_at) }))
    };
  });

  app.post('/spin', async (req) => {
    const prize = pickWeightedPrize();

    // Daily-allotment rollover, spin row, prize credit and spin count are one atomic Postgres call.
    // "Extra spin" refunds the spin it cost, so it never reduces the user's count for the day.
    const { data, error } = await db.rpc('spin', {
      p_user: req.session!.uid,
      p_prize_id: prize.id,
      p_label: prize.label,
      p_amount: prize.amount,
      p_ref: generateReference(),
      p_today: new Date().toISOString().slice(0, 10),
      p_max: MAX_DAILY_SPINS
    });

    if (error) {
      const msg = rpcMessage(error);
      if (msg === 'NO_SPINS_LEFT') throw conflict("You're out of spins for today.");
      if (msg === 'USER_NOT_FOUND') throw notFound('User not found.');
      console.error('[streak/spin]', error);
      throw new HttpError(500, 'Could not process spin.');
    }

    await analytics.safeLog('spin_reward', data.amount, 'streak/spin');
    return { ok: true, ...data };
  });

  app.get('/spin/status', async (req) => {
    const { data: user } = await db.from('profiles').select('spins_used, spins_date').eq('id', req.session!.uid).maybeSingle();

    // Spins reset every day — if the stored date isn't today the user has their full allotment
    // (read-only; the actual reset happens inside the spin function on the next POST).
    const today = new Date().toISOString().slice(0, 10);
    const spinsUsed = user?.spins_date === today ? (user?.spins_used ?? 0) : 0;
    return { spinsLeft: Math.max(0, MAX_DAILY_SPINS - spinsUsed), maxSpins: MAX_DAILY_SPINS };
  });
};
export default streakRoutes;
