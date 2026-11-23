// Loan lifecycle (identical to the frontends' src/lib/loans/config.ts).
export const LOAN_STAGES = ['pending', 'processing', 'approved', 'disbursed'] as const;
export type LoanStage = (typeof LOAN_STAGES)[number];

export const LOAN_STAGE_LABELS: Record<LoanStage, string> = {
  pending: 'Pending',
  processing: 'Processing',
  approved: 'Approved',
  disbursed: 'Disbursed'
};

export const MIN_LOAN_AMOUNT = 1_000;
export const MAX_LOAN_AMOUNT = 5_000_000;

export const isLoanStage = (v: unknown): v is LoanStage => typeof v === 'string' && (LOAN_STAGES as readonly string[]).includes(v);

export function nextLoanStage(current: LoanStage): LoanStage | null {
  const i = LOAN_STAGES.indexOf(current);
  return i >= 0 && i < LOAN_STAGES.length - 1 ? LOAN_STAGES[i + 1] : null;
}

export type LoanActor = 'user' | 'admin';
export type LoanTimelineStep = { status: LoanStage; label: string; reachedAt: string | null; by: LoanActor | null };
type RawEntry = { status?: string; at?: string | null; by?: LoanActor };

export function buildLoanTimeline(entries: RawEntry[]): LoanTimelineStep[] {
  const byStage = new Map<string, RawEntry>();
  entries.forEach((e) => {
    if (e.status) byStage.set(e.status, e);
  });
  return LOAN_STAGES.map((status) => {
    const entry = byStage.get(status);
    return {
      status,
      label: LOAN_STAGE_LABELS[status],
      reachedAt: entry?.at ? new Date(entry.at).toISOString() : null,
      by: entry?.by ?? null
    };
  });
}
