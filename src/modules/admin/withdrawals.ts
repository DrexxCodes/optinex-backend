import type { FastifyPluginAsync } from 'fastify';
import { HttpError, notFound } from '@/lib/errors';
import { iso, num, rpcMessage } from '@/lib/db/format';
import { bodyOf, paramsOf } from '../helpers';

const withdrawalAdminRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.c;

  app.get('/requests', async () => {
    // One query: pending withdrawals with the owner's name joined in.
    const { data } = await db
      .from('withdrawals')
      .select('id, user_id, amount, payout_method, reference, created_at, profiles(full_name, username)')
      .eq('status', 'pending');

    const requests = (data ?? []).map((r: any) => ({
      id: r.id,
      uid: r.user_id,
      fullName: r.profiles?.full_name ?? 'Unknown user',
      username: r.profiles?.username ?? '',
      amount: num(r.amount),
      payoutMethod: r.payout_method,
      reference: r.reference,
      createdAt: iso(r.created_at)
    }));
    requests.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return { requests };
  });

  // approve: the wallet was already debited at request time and the payout happens externally, so this just
  // marks it 'paid'. reject: marks it failed, refunds the wallet and records the credit — atomically.
  app.patch('/requests/:id', async (req) => {
    const { action } = bodyOf(req);
    if (action !== 'approve' && action !== 'reject') throw new HttpError(400, 'Invalid action.');

    const { error } = await db.rpc('resolve_withdrawal', { p_id: paramsOf(req).id, p_action: action });
    if (error) {
      const msg = rpcMessage(error);
      if (msg === 'NOT_FOUND') throw notFound('Request not found.');
      if (msg === 'RESOLVED') throw new HttpError(400, 'This request has already been resolved.');
      console.error('[admin/withdrawals resolve]', error);
      throw new HttpError(500, 'Could not resolve this request.');
    }
    return { ok: true };
  });

  app.get('/settings', async () => {
    const data = await config.get<{ enabledDate?: string }>('withdrawal');
    return { enabledDate: data?.enabledDate ? new Date(data.enabledDate).toISOString() : null };
  });

  app.put('/settings', async (req) => {
    const { enabledDate } = bodyOf(req);
    const date = enabledDate ? new Date(enabledDate) : null;
    if (!date || Number.isNaN(date.getTime())) throw new HttpError(400, 'Pick a date.');
    await config.merge('withdrawal', { enabledDate: date.toISOString() });
    return { ok: true };
  });
};
export default withdrawalAdminRoutes;
