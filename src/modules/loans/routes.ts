import type { FastifyPluginAsync } from 'fastify';
import { HttpError, tooManyRequests } from '@/lib/errors';
import { generateReference } from '@/lib/refGenerator';
import { iso, num, rpcMessage } from '@/lib/db/format';
import { buildLoanTimeline, MAX_LOAN_AMOUNT, MIN_LOAN_AMOUNT } from '@/config/loans';
import { validateLoanInput } from '@/lib/loanValidation';
import { bodyOf } from '../helpers';

const loanRoutes: FastifyPluginAsync = async (app) => {
  const { db, paystack, analytics, eligibility, rateLimit } = app.c;
  app.addHook('preHandler', app.authenticate);

  // Everything the loans page needs in one call: may the user apply, and their applications with timelines.
  app.get('/', async (req) => {
    const uid = req.session!.uid;
    const limit = await rateLimit('loan-list', uid, 30, 60);
    if (!limit.allowed) throw tooManyRequests(limit.retryAfter);

    const [profile, loansRes] = await Promise.all([
      db.from('profiles').select('account_tier').eq('id', uid).maybeSingle(),
      // Loans and their timeline rows come back in a single round trip.
      db
        .from('loans')
        .select('id, amount, status, reference, bank_account, created_at, loan_timeline(status, at, by)')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(20)
    ]);

    const block = await eligibility.getLoanBlock(uid, profile.data?.account_tier);

    const loans = (loansRes.data ?? []).map((l: any) => ({
      id: l.id,
      amount: num(l.amount),
      status: l.status,
      reference: l.reference,
      bankAccount: l.bank_account,
      createdAt: iso(l.created_at),
      timeline: buildLoanTimeline(l.loan_timeline ?? [])
    }));

    return {
      allowed: !block,
      blockCode: block?.code ?? null,
      reason: block?.message ?? null,
      hasPending: loans.some((l) => l.status === 'pending'),
      limits: { min: MIN_LOAN_AMOUNT, max: MAX_LOAN_AMOUNT },
      loans
    };
  });

  app.post('/apply', async (req) => {
    const uid = req.session!.uid;

    // 5 submissions per hour per user — plenty for honest retries, and caps Paystack lookups per account.
    const limit = await rateLimit('loan-apply', uid, 5, 60 * 60);
    if (!limit.allowed) throw tooManyRequests(limit.retryAfter, 'You have submitted too many loan applications. Please try again later.');

    const parsed = validateLoanInput(bodyOf(req));
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    const input = parsed.value;

    // The account name and bank name are always (re)resolved server-side straight from Paystack.
    const [banks, resolved] = await Promise.all([paystack.fetchBanks(), paystack.resolveAccount(input.accountNumber, input.bankCode)]);
    if (!resolved.ok) throw new HttpError(resolved.status, resolved.error);

    const bank = banks?.find((b) => b.code === input.bankCode);
    if (!bank) throw new HttpError(400, 'That bank is not supported.');

    const { data: user } = await db.from('profiles').select('full_name, email, account_tier').eq('id', uid).maybeSingle();
    if (!user) throw new HttpError(500, 'Could not submit your loan application.');

    const block = await eligibility.getLoanBlock(uid, user.account_tier);
    if (block) throw new HttpError(400, block.message);

    const reference = generateReference();

    // The one-pending-application lock, the loan row and its first immutable timeline entry are written
    // atomically (the profile row is locked inside the function).
    const { data: loanId, error } = await db.rpc('create_loan', {
      p_user: uid,
      p_ref: reference,
      p_amount: input.amount,
      p_reason: input.reason,
      // Name and email always come from the account, never from the request.
      p_applicant: { fullName: user.full_name ?? '', email: user.email ?? '', phone: input.phone, address: input.address, occupation: input.occupation },
      p_next_of_kin: { name: input.nextOfKinName, phone: input.nextOfKinPhone },
      p_bank: { accountNumber: input.accountNumber, bankCode: input.bankCode, bankName: bank.name, accountName: resolved.accountName }
    });

    if (error) {
      if (rpcMessage(error) === 'PENDING_EXISTS') {
        throw new HttpError(400, 'You already have a pending loan application. Wait for it to be reviewed before applying again.');
      }
      console.error('[loans/apply]', error);
      throw new HttpError(500, 'Could not submit your loan application.');
    }

    await analytics.safeLog('loan_requested', input.amount, 'loans/apply');
    return { ok: true, reference, loanId };
  });
};
export default loanRoutes;
