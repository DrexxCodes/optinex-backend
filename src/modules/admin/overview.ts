import type { FastifyPluginAsync } from 'fastify';
import { HttpError } from '@/lib/errors';

const pad = (n: number) => String(n).padStart(2, '0');

// Last `days` daily analytics ids, most recent last, e.g. ['2026-07-26', '2026-07-27', '2026-07-28'].
function lastDayIds(days: number) {
  const ids: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    ids.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  return ids;
}

const overviewRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => {
    const now = new Date();
    const monthId = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const yearId = `${now.getFullYear()}`;
    const dayIds = lastDayIds(3);

    // Every count, sum and per-package subscriber tally comes back from ONE Postgres call.
    const { data: o, error } = await app.c.db.rpc('admin_overview', { p_day_ids: dayIds, p_month: monthId, p_year: yearId });
    if (error || !o) {
      console.error('[admin/overview]', error);
      throw new HttpError(500, 'Could not load the overview.');
    }

    const byDate = new Map<string, any>((o.daily ?? []).map((d: any) => [d.date as string, d]));
    const signups = dayIds.map((date) => ({ date, signups: byDate.get(date)?.signups ?? 0 }));
    const todayEntry = byDate.get(dayIds[dayIds.length - 1]);

    return {
      totalUsers: o.totalUsers,
      freeUsers: o.freeUsers,
      upgradedUsers: o.upgradedUsers,
      pendingUpgrades: o.pendingUpgrades,
      pendingInvestments: o.pendingInvestments,
      pendingWithdrawals: o.pendingWithdrawals,
      pendingWithdrawalTotal: o.pendingWithdrawalTotal,
      packages: o.packages ?? [],
      signups,
      // "Financial Stats" is real revenue only — money confirmed when an admin approves a receipt.
      financial: {
        daily: { label: dayIds[dayIds.length - 1], amountTotal: todayEntry?.revenueTotal ?? 0, total: todayEntry?.revenueEvents ?? 0 },
        monthly: { label: monthId, amountTotal: o.monthly?.revenueTotal ?? 0, total: o.monthly?.revenueEvents ?? 0 },
        yearly: { label: yearId, amountTotal: o.yearly?.revenueTotal ?? 0, total: o.yearly?.revenueEvents ?? 0 }
      }
    };
  });
};
export default overviewRoutes;
