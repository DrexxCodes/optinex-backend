import type { FastifyPluginAsync } from 'fastify';
import { HttpError, conflict, notFound } from '@/lib/errors';
import { buildLoanTimeline, isLoanStage, LOAN_STAGES, nextLoanStage } from '@/config/loans';
import { iso, num, rpcMessage } from '@/lib/db/format';
import { bodyOf, paramsOf, queryOf } from '../helpers';

const LIST_LIMIT = 200;

const loanAdminRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.c;

  // Lists applications, optionally filtered by ?status=, plus a per-stage count for the tabs.
  app.get('/', async (req) => {
    const status = queryOf(req).status;

    let listQuery = db
      .from('loans')
      .select(
        'id, user_id, full_name, username, amount, status, reference, bank_account, reason, applicant, next_of_kin, created_at, status_changed_at, profiles(full_name, username)'
      )
      .order('created_at', { ascending: false })
      .limit(LIST_LIMIT);
    if (isLoanStage(status)) listQuery = listQuery.eq('status', status);

    const [listRes, ...countRes] = await Promise.all([
      listQuery,
      ...LOAN_STAGES.map((s) => db.from('loans').select('id', { count: 'exact', head: true }).eq('status', s))
    ]);

    const counts = Object.fromEntries(LOAN_STAGES.map((s, i) => [s, countRes[i].count ?? 0])) as Record<string, number>;

    const loans = (listRes.data ?? []).map((l: any) => {
      const user = l.profiles;
      return {
        id: l.id,
        uid: l.user_id,
        // Live user lookup first, falling back to the snapshot taken at application time.
        fullName: user?.full_name ?? l.full_name ?? 'Unknown user',
        username: user?.username ?? l.username ?? '',
        amount: num(l.amount),
        status: l.status,
        reference: l.reference,
        bankAccount: l.bank_account,
        reason: l.reason ?? null,
        applicant: l.applicant ?? null,
        nextOfKin: l.next_of_kin ?? null,
        createdAt: iso(l.created_at),
        statusChangedAt: iso(l.status_changed_at)
      };
    });

    return { loans, counts };
  });

  // Full timeline for one application (the list stays light by not reading every timeline).
  app.get('/:id', async (req) => {
    const { id } = paramsOf(req);
    const { data: loan } = await db.from('loans').select('status, loan_timeline(status, at, by)').eq('id', id).maybeSingle();
    if (!loan) throw notFound('Application not found.');
    return { id, status: loan.status, timeline: buildLoanTimeline((loan as any).loan_timeline ?? []) };
  });

  // Moves an application exactly one step forward. Both stages are checked against the live row inside a
  // Postgres function (row locked), so a double-click or two admins at once can never skip a stage.
  app.patch('/:id', async (req) => {
    const { from, to } = bodyOf(req);
    if (!isLoanStage(from) || !isLoanStage(to) || nextLoanStage(from) !== to) {
      throw new HttpError(400, 'Applications can only move one step forward.');
    }

    const { error } = await db.rpc('advance_loan', { p_id: paramsOf(req).id, p_from: from, p_to: to, p_admin: req.admin!.uid });
    if (error) {
      const msg = rpcMessage(error);
      if (msg === 'NOT_FOUND') throw notFound('Application not found.');
      if (msg === 'STALE') throw conflict('This application has already moved on. Refresh to see its latest status.');
      console.error('[admin/loans PATCH]', error);
      throw new HttpError(500, 'Could not update this application.');
    }
    return { ok: true };
  });
};
export default loanAdminRoutes;
