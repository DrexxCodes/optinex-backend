import type { FastifyPluginAsync } from 'fastify';
import { HttpError, notFound } from '@/lib/errors';
import { iso, num, rpcMessage } from '@/lib/db/format';
import { bodyOf, paramsOf } from '../helpers';

// /api/admin/investments/{bank,packages,packages/:id,requests,requests/:id}
const investmentAdminRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, analytics } = app.c;

  app.get('/bank', async () => (await config.get('bank')) ?? { bankName: '', accountNumber: '', accountName: '' });

  app.put('/bank', async (req) => {
    const { bankName, accountNumber, accountName } = bodyOf(req);
    if (!bankName || !accountNumber || !accountName) throw new HttpError(400, 'Bank name, account number, and account name are all required.');
    await config.merge('bank', { bankName, accountNumber, accountName });
    return { ok: true };
  });

  app.get('/packages', async () => {
    const { data } = await db.from('packages').select('id, name, price, duration, details, active').order('price', { ascending: true });
    return {
      packages: (data ?? []).map((p: any) => ({
        id: p.id,
        name: p.name,
        price: num(p.price),
        duration: p.duration,
        details: p.details ?? [],
        active: p.active !== false
      }))
    };
  });

  app.post('/packages', async (req) => {
    const { name, price, duration, details } = bodyOf(req);
    if (!name || !price || price <= 0 || !duration) throw new HttpError(400, 'Name, price, and duration are required.');

    const { data, error } = await db
      .from('packages')
      .insert({ name, price, duration, details: Array.isArray(details) ? details.filter(Boolean) : [], active: true })
      .select('id')
      .single();
    if (error || !data) throw new HttpError(500, 'Could not create this package.');
    return { ok: true, id: data.id };
  });

  app.patch('/packages/:id', async (req) => {
    const body = bodyOf(req);
    const update: Record<string, unknown> = {};
    for (const key of ['name', 'price', 'duration', 'details', 'active'] as const) {
      if (body[key] !== undefined) update[key] = body[key];
    }
    if (Object.keys(update).length === 0) throw new HttpError(400, 'Nothing to update.');

    const { error } = await db.from('packages').update(update).eq('id', paramsOf(req).id);
    if (error) throw new HttpError(500, 'Could not update this package.');
    return { ok: true };
  });

  app.delete('/packages/:id', async (req) => {
    await db.from('packages').delete().eq('id', paramsOf(req).id);
    return { ok: true };
  });

  app.get('/requests', async () => {
    // One query: pending investments with the owner's name joined in (no per-row user lookups).
    const { data } = await db
      .from('investments')
      .select('id, user_id, package_name, amount, receipt_url, reference, created_at, profiles(full_name, username)')
      .eq('status', 'pending');

    const requests = (data ?? []).map((r: any) => ({
      id: r.id,
      uid: r.user_id,
      fullName: r.profiles?.full_name ?? 'Unknown user',
      username: r.profiles?.username ?? '',
      packageName: r.package_name,
      amount: num(r.amount),
      receiptUrl: r.receipt_url,
      reference: r.reference,
      createdAt: iso(r.created_at)
    }));
    requests.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return { requests };
  });

  app.patch('/requests/:id', async (req) => {
    const { action } = bodyOf(req); // 'approve' | 'reject'
    if (action !== 'approve' && action !== 'reject') throw new HttpError(400, 'Invalid action.');

    // One atomic Postgres function (row locked): the status flip and — on approve — the user's package fields.
    const { data: amount, error } = await db.rpc('resolve_investment', { p_id: paramsOf(req).id, p_action: action });
    if (error) {
      const msg = rpcMessage(error);
      if (msg === 'NOT_FOUND') throw notFound('Request not found.');
      if (msg === 'RESOLVED') throw new HttpError(400, 'This request has already been resolved.');
      if (msg === 'PACKAGE_NOT_FOUND') throw notFound('Package not found.');
      console.error('[admin/investments resolve]', error);
      throw new HttpError(500, 'Could not resolve this request.');
    }

    if (action === 'approve') await analytics.safeLog('investment_verified', Number(amount ?? 0), 'admin/investments');
    return { ok: true };
  });
};
export default investmentAdminRoutes;
