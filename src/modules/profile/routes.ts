import type { FastifyPluginAsync } from 'fastify';
import { HttpError, notFound } from '@/lib/errors';
import { avatarPath } from '@/lib/dicebear';
import { num } from '@/lib/db/format';
import { bodyOf } from '../helpers';

// /api/user/me — the single fetch the dashboard shell needs (wallet, package, payout status).
const profileRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.c;
  app.addHook('preHandler', app.authenticate);

  app.get('/me', async (req) => {
    const { data: p } = await db.from('profiles').select('*').eq('id', req.session!.uid).maybeSingle();
    if (!p) throw notFound('User not found.');

    return {
      uid: p.id,
      fullName: p.full_name,
      email: p.email,
      username: p.username,
      walletAmount: num(p.wallet_amount),
      packageStatus: p.package_status ?? 'Free',
      packageName: p.package_name ?? undefined,
      packageExpiresAt: p.package_expires_at ?? undefined,
      isChangingPackage: p.is_changing_package ?? false,
      accountTier: p.account_tier ?? 'standard',
      upgradeStatus: p.upgrade_status ?? 'none',
      payoutMethod: p.payout_method ?? null,
      admin: !!p.is_admin,
      avatarUrl: avatarPath(p.email)
    };
  });

  app.patch('/me', async (req) => {
    const body = bodyOf(req);
    if (body.fullName === undefined) throw new HttpError(400, 'Nothing to update.');
    if (typeof body.fullName !== 'string' || body.fullName.length > 100) throw new HttpError(400, 'Enter a valid name.');

    const { error } = await db.from('profiles').update({ full_name: body.fullName }).eq('id', req.session!.uid);
    if (error) throw new HttpError(500, 'Could not update your profile.');
    return { ok: true };
  });
};
export default profileRoutes;
