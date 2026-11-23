// Global analytics — one atomic Postgres call upserts the daily / monthly / yearly rows.
// NOTE: day/month/year keys use this process's LOCAL date (as the Next.js servers did) — set TZ accordingly.
import type { Db } from './types';

export type AnalyticsAction =
  | 'signup'
  | 'signin'
  | 'checkin'
  | 'spin_reward'
  | 'task_completed'
  | 'investment_submitted'
  | 'investment_verified'
  | 'withdrawal_requested'
  | 'loan_requested'
  | 'casino_score_submitted'
  | 'referral_bonus'
  | 'account_upgrade_submitted'
  | 'account_upgrade_verified'
  | 'package_change_submitted';

// Only money the platform has actually realized (an admin approved the receipt) counts as revenue.
const REVENUE_ACTIONS: AnalyticsAction[] = ['investment_verified', 'account_upgrade_verified'];
const pad = (n: number) => String(n).padStart(2, '0');

export function createAnalytics(db: Db) {
  async function log(action: AnalyticsAction, amount = 0) {
    const now = new Date();
    const { error } = await db.rpc('log_analytics_event', {
      p_action: action,
      p_amount: amount,
      p_day: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      p_month: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`,
      p_year: `${now.getFullYear()}`,
      p_revenue: REVENUE_ACTIONS.includes(action)
    });
    if (error) throw new Error(error.message);
  }
  return {
    log,
    /** Fire-and-forget variant: analytics must never fail a user-facing request. */
    async safeLog(action: AnalyticsAction, amount = 0, tag = 'analytics') {
      try {
        await log(action, amount);
      } catch (e) {
        console.error(`[${tag}] analytics`, e);
      }
    }
  };
}
export type Analytics = ReturnType<typeof createAnalytics>;
