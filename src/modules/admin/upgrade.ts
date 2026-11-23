import type { FastifyPluginAsync } from 'fastify';
import { HttpError, notFound } from '@/lib/errors';
import { iso, num, rpcMessage } from '@/lib/db/format';
import { bodyOf, paramsOf } from '../helpers';

const upgradeAdminRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, analytics } = app.c;

  app.get('/requests', async () => {
    const { data } = await db
      .from('account_upgrades')
      .select('id, user_id, amount, receipt_url, reference, created_at, profiles(full_name, username)')
      .eq('status', 'pending');

    const requests = (data ?? []).map((r: any) => ({
      id: r.id,
      uid: r.user_id,
      fullName: r.profiles?.full_name ?? 'Unknown user',
      username: r.profiles?.username ?? '',
      amount: num(r.amount),
      receiptUrl: r.receipt_url,
      reference: r.reference,
      createdAt: iso(r.created_at)
    }));
    requests.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return { requests };
  });

  // Request row + the user's tier/status flip in one atomic call (row locked; double-resolves rejected).
  app.patch('/requests/:id', async (req) => {
    const { action } = bodyOf(req);
    if (action !== 'approve' && action !== 'reject') throw new HttpError(400, 'Invalid action.');

    const { data: amount, error } = await db.rpc('resolve_upgrade', { p_id: paramsOf(req).id, p_action: action });
    if (error) {
      const msg = rpcMessage(error);
      if (msg === 'NOT_FOUND') throw notFound('Request not found.');
      if (msg === 'RESOLVED') throw new HttpError(400, 'This request has already been resolved.');
      console.error('[admin/upgrade resolve]', error);
      throw new HttpError(500, 'Could not resolve this request.');
    }

    if (action === 'approve') await analytics.safeLog('account_upgrade_verified', Number(amount ?? 0), 'admin/upgrade');
    return { ok: true };
  });

  app.get('/settings', async () => (await config.get('upgrade')) ?? { price: null, bankName: '', accountNumber: '', accountName: '' });

  app.put('/settings', async (req) => {
    const { price, bankName, accountNumber, accountName } = bodyOf(req);
    if (!price || price <= 0) throw new HttpError(400, 'Enter a valid price.');
    if (!bankName || !accountNumber || !accountName) throw new HttpError(400, 'Bank name, account number, and account name are all required.');
    await config.merge('upgrade', { price, bankName, accountNumber, accountName });
    return { ok: true };
  });
};
export default upgradeAdminRoutes;
