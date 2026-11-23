import type { FastifyPluginAsync } from 'fastify';
import { HttpError, notFound } from '@/lib/errors';
import { generateReference } from '@/lib/refGenerator';
import { iso, num, rpcMessage, UUID_RE } from '@/lib/db/format';
import { bodyOf, paramsOf, queryOf } from '../helpers';

const STATUSES = ['pending', 'active', 'failed', 'revoked'] as const;
type Status = (typeof STATUSES)[number];
const normalizeStatus = (s: unknown): Status => (STATUSES.includes(s as Status) ? (s as Status) : 'failed');
const epochToIso = (n: unknown) => (typeof n === 'number' ? new Date(n).toISOString() : null);

const userAdminRoutes: FastifyPluginAsync = async (app) => {
  const { db, wallet } = app.c;

  // Looks a single user up by exact email or exact username — one indexed-equality query.
  app.get('/', async (req) => {
    const q = queryOf(req);
    const query = (q.email ?? q.username ?? q.q)?.trim();
    if (!query) throw new HttpError(400, 'Provide an email or username to search for.');

    // An email always contains "@"; anything else is treated as a username.
    const field = query.includes('@') ? 'email' : 'username';
    const { data: u } = await db
      .from('profiles')
      .select('id, full_name, username, email, wallet_amount, package_status, account_tier, is_admin, created_at')
      .eq(field, query.toLowerCase())
      .limit(1)
      .maybeSingle();
    if (!u) throw notFound(`No user found with that ${field}.`);

    return {
      user: {
        uid: u.id,
        fullName: u.full_name,
        username: u.username,
        email: u.email,
        walletAmount: num(u.wallet_amount),
        packageStatus: u.package_status ?? 'Free',
        accountTier: u.account_tier ?? 'standard',
        admin: u.is_admin === true,
        createdAt: iso(u.created_at)
      }
    };
  });

  app.patch('/:id', async (req) => {
    const { id } = paramsOf(req);
    const { admin: makeAdmin } = bodyOf(req);
    if (typeof makeAdmin !== 'boolean') throw new HttpError(400, 'Invalid request.');
    if (id === req.admin!.uid && !makeAdmin) throw new HttpError(400, "You can't remove your own admin access.");
    if (!UUID_RE.test(id)) throw notFound('User not found.');

    const { data, error } = await db.from('profiles').update({ is_admin: makeAdmin }).eq('id', id).select('id');
    if (error) throw new HttpError(500, 'Could not update this user.');
    if (!data?.length) throw notFound('User not found.');
    return { ok: true };
  });

  // Everything this user has ever bought — package investments and account upgrades — newest first.
  app.get('/:id/subscriptions', async (req) => {
    const { id } = paramsOf(req);
    if (!UUID_RE.test(id)) throw notFound('User not found.');

    const [userRes, invRes, upRes] = await Promise.all([
      db.from('profiles').select('package_id, package_started_at, package_expires_at').eq('id', id).maybeSingle(),
      db.from('investments').select('*').eq('user_id', id),
      db.from('account_upgrades').select('*').eq('user_id', id)
    ]);
    const user = userRes.data;
    if (!user) throw notFound('User not found.');

    const investments = invRes.data ?? [];

    // A profile only holds ONE package (the last one approved) but older approved rows stay `active`, so
    // "live" = the newest active row for the package the profile currently points at (same rule as revoke).
    let liveId: string | null = null;
    if (user.package_id) {
      const active = investments
        .filter((r: any) => r.status === 'active' && r.package_id === user.package_id)
        .sort((a: any, b: any) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || String(b.id).localeCompare(String(a.id)));
      liveId = active[0]?.id ?? null;
    }

    const packages = investments.map((r: any) => {
      const status = normalizeStatus(r.status);
      const current = status === 'active' && liveId === r.id;
      return {
        id: r.id,
        kind: 'package' as const,
        name: r.package_name ?? 'Package',
        amount: num(r.amount),
        reference: r.reference ?? '',
        receiptUrl: r.receipt_url ?? '',
        status,
        current,
        startedAt: current ? epochToIso(user.package_started_at) : null,
        expiresAt: current ? epochToIso(user.package_expires_at) : null,
        expired: current && typeof user.package_expires_at === 'number' && user.package_expires_at < Date.now(),
        createdAt: iso(r.created_at)
      };
    });

    const upgrades = (upRes.data ?? []).map((r: any) => {
      const status = normalizeStatus(r.status);
      return {
        id: r.id,
        kind: 'upgrade' as const,
        name: 'Account Upgrade',
        amount: num(r.amount),
        reference: r.reference ?? '',
        receiptUrl: r.receipt_url ?? '',
        status,
        current: status === 'active',
        startedAt: null,
        expiresAt: null,
        expired: false,
        createdAt: iso(r.created_at)
      };
    });

    const subscriptions = [...packages, ...upgrades].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return { subscriptions };
  });

  // Revokes an ACTIVE package investment or account upgrade (row kept as 'revoked' for the audit trail).
  // One Postgres function, profile row locked, so "is it live?" can't be split by a concurrent approval.
  app.patch('/:id/subscriptions/:subId', async (req) => {
    const { id, subId } = paramsOf(req);
    const { kind } = bodyOf(req);
    if (kind !== 'package' && kind !== 'upgrade') throw new HttpError(400, 'Invalid request.');
    if (!UUID_RE.test(id)) throw notFound('User not found.');

    const { data, error } = await db.rpc('revoke_subscription', { p_user: id, p_sub: subId, p_kind: kind, p_admin: req.admin!.uid });
    if (error) {
      const msg = rpcMessage(error);
      if (msg === 'USER_NOT_FOUND') throw notFound('User not found.');
      if (msg === 'SUB_NOT_FOUND') throw notFound('Subscription not found.');
      if (msg === 'NOT_ACTIVE') throw new HttpError(400, 'Only active subscriptions can be revoked.');
      console.error('[admin/revoke]', error);
      throw new HttpError(500, 'Could not revoke this subscription.');
    }
    return { ok: true, ...(data ?? {}) };
  });

  app.get('/:id/transactions', async (req) => {
    const { id } = paramsOf(req);
    const q = queryOf(req);
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 50);

    if (!UUID_RE.test(id)) return { transactions: [], hasMore: false, nextCursor: null };
    return wallet.list(id, limit, q.cursor ?? null);
  });

  app.post('/:id/wallet', async (req) => {
    const { id } = paramsOf(req);
    const { amount, note } = bodyOf(req);
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Enter a valid amount greater than zero.');
    if (!UUID_RE.test(id)) throw notFound('User not found.');

    const txnRef = generateReference();
    // Wallet bump + transaction row in one atomic call, with the exact fields the user app's history expects.
    const { data: balance, error } = await db.rpc('credit_wallet', {
      p_user: id,
      p_amount: amount,
      p_name: (typeof note === 'string' && note.trim()) || 'Wallet funded by admin',
      p_ref: txnRef
    });
    if (error) {
      if (rpcMessage(error) === 'USER_NOT_FOUND') throw notFound('User not found.');
      console.error('[admin/wallet]', error);
      throw new HttpError(500, 'Could not fund this wallet.');
    }
    return { ok: true, walletAmount: Number(balance ?? 0), txnRef };
  });
};
export default userAdminRoutes;
