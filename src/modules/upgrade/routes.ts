import type { FastifyPluginAsync } from 'fastify';
import { HttpError } from '@/lib/errors';
import { generateReference } from '@/lib/refGenerator';
import { num } from '@/lib/db/format';
import { bodyOf } from '../helpers';

const upgradeRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, analytics } = app.c;
  app.addHook('preHandler', app.authenticate);

  app.get('/status', async (req) => {
    const uid = req.session!.uid;
    const [cfg, userRes, latestRes] = await Promise.all([
      config.get('upgrade'),
      db.from('profiles').select('account_tier, upgrade_status').eq('id', uid).maybeSingle(),
      db.from('account_upgrades').select('id, amount, status, reference').eq('user_id', uid).order('created_at', { ascending: false }).limit(1)
    ]);

    const r = latestRes.data?.[0];
    const latest = r ? { id: r.id, amount: num(r.amount), status: r.status, reference: r.reference } : null;
    const user = userRes.data;

    return {
      price: cfg?.price ?? null,
      bank: cfg ? { bankName: cfg.bankName, accountNumber: cfg.accountNumber, accountName: cfg.accountName } : null,
      accountTier: user?.account_tier ?? 'standard',
      upgradeStatus: user?.upgrade_status ?? 'none',
      latestRequest: latest
    };
  });

  app.post('/subscribe', async (req) => {
    const uid = req.session!.uid;
    const { receiptUrl } = bodyOf(req);
    if (!receiptUrl) throw new HttpError(400, 'A receipt is required.');

    const cfg = await config.get('upgrade');
    if (!cfg?.price) throw new HttpError(400, "Account upgrades aren't available right now.");
    const price = Number(cfg.price);

    const { data: user } = await db.from('profiles').select('account_tier, upgrade_status').eq('id', uid).maybeSingle();
    if (user?.account_tier === 'upgraded') throw new HttpError(400, 'Your account is already upgraded.');
    if (user?.upgrade_status === 'pending') throw new HttpError(400, 'You already have an upgrade request pending verification.');

    const reference = generateReference();
    const { data: upgrade, error } = await db
      .from('account_upgrades')
      .insert({ user_id: uid, amount: price, receipt_url: receiptUrl, status: 'pending', reference })
      .select('id')
      .single();
    if (error || !upgrade) {
      console.error('[upgrade/subscribe]', error);
      throw new HttpError(500, 'Could not submit your upgrade request.');
    }

    await db.from('profiles').update({ upgrade_status: 'pending' }).eq('id', uid);
    await analytics.safeLog('account_upgrade_submitted', price, 'upgrade');

    return { ok: true, reference, upgradeId: upgrade.id };
  });
};
export default upgradeRoutes;
