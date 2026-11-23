import type { Db } from './db/types';
import { MIN_DISTINCT_PACKAGES } from '@/config/constants';

export function createEligibility(db: Db) {
  /** Counts the distinct package ids among a user's active investments. */
  async function distinctActivePackageCount(uid: string): Promise<number> {
    const { data, error } = await db.rpc('distinct_active_package_count', { p_user: uid });
    if (error) throw new Error(error.message);
    return Number(data ?? 0);
  }

  /**
   * Loan gatekeeper — upgraded account + at least MIN_DISTINCT_PACKAGES different active packages, with
   * messages that tell the user exactly what to do next. Returns the first failing rule, or null.
   */
  async function getLoanBlock(uid: string, accountTier: string | null | undefined) {
    if (accountTier !== 'upgraded') {
      return { code: 'UPGRADE_REQUIRED' as const, message: 'You need to upgrade your account first before you can apply for a loan.' };
    }
    const count = await distinctActivePackageCount(uid);
    if (count >= MIN_DISTINCT_PACKAGES) return null;
    if (count === 0) {
      return { code: 'PACKAGE_REQUIRED' as const, message: `You need at least ${MIN_DISTINCT_PACKAGES} active packages to apply for a loan.` };
    }
    const remaining = MIN_DISTINCT_PACKAGES - count;
    return {
      code: 'MORE_PACKAGES_REQUIRED' as const,
      message: `You have ${count} active package${count === 1 ? '' : 's'}. Add ${remaining === 1 ? 'one more package' : `${remaining} more packages`} to apply for a loan.`
    };
  }

  return { distinctActivePackageCount, getLoanBlock };
}
export type Eligibility = ReturnType<typeof createEligibility>;
