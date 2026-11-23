import type { FastifyPluginAsync } from 'fastify';
import { MIN_DISTINCT_PACKAGES } from '@/config/constants';
import { HttpError, tooManyRequests } from '@/lib/errors';
import { generateReference } from '@/lib/refGenerator';
import { num, rpcMessage } from '@/lib/db/format';
import { bodyOf } from '../helpers';

const WITHDRAWAL_ERRORS: Record<string, string> = {
  WITHDRAWAL_NOT_ENABLED: "Withdrawal isn't enabled yet. Check back later.",
  UPGRADE_REQUIRED: 'You must upgrade your account to access withdrawals.',
  PACKAGE_REQUIRED: 'A paid package is required before you can withdraw.',
  MULTIPLE_PACKAGES_REQUIRED: `You need at least ${MIN_DISTINCT_PACKAGES} different packages before you can withdraw.`,
  NO_PAYOUT_METHOD: 'Add your payout details before requesting a withdrawal.',
  INSUFFICIENT_BALANCE: 'Your wallet balance is too low for this amount.'
};

const withdrawalRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, paystack, analytics, eligibility, rateLimit } = app.c;
  app.addHook('preHandler', app.authenticate);

  // Paystack's bank list (secret key stays server-side). De-duplicated by code, cached 24h in memory.
  app.get('/banks', async (req) => {
    const limit = await rateLimit('bank-list', req.session!.uid, 30, 60);
    if (!limit.allowed) throw tooManyRequests(limit.retryAfter);

    const banks = await paystack.fetchBanks();
    if (!banks) throw new HttpError(502, 'Could not load bank list.');
    return { banks };
  });

  // Resolves an account name for an account number + bank code before it's saved. Every call costs a
  // Paystack lookup, so it's capped per user.
  app.post('/resolve-account', async (req) => {
    const limit = await rateLimit('resolve-account', req.session!.uid, 10, 60);
    if (!limit.allowed) throw tooManyRequests(limit.retryAfter, 'Too many account lookups. Wait a moment and try again.');

    const { accountNumber, bankCode } = bodyOf(req);
    if (!accountNumber || !bankCode) throw new HttpError(400, 'Account number and bank are required.');

    const resolved = await paystack.resolveAccount(String(accountNumber), String(bankCode));
    if (!resolved.ok) throw new HttpError(resolved.status, resolved.error);
    return { accountName: resolved.accountName };
  });

  app.post('/payout-method', async (req) => {
    const { accountNumber, bankCode, bankName, accountName } = bodyOf(req);
    if (!accountNumber || !bankCode || !bankName || !accountName) throw new HttpError(400, 'Complete bank details are required.');

    const { error } = await db
      .from('profiles')
      .update({ payout_method: { accountNumber, bankCode, bankName, accountName } })
      .eq('id', req.session!.uid);
    if (error) throw new HttpError(500, 'Could not save your payout details.');
    return { ok: true };
  });

  app.post('/request', async (req) => {
    const { amount } = bodyOf(req);
    if (!amount || amount <= 0) throw new HttpError(400, 'Enter a valid amount.');

    // Every gatekeeper rule, the balance check, the withdrawal row, the wallet debit and its transaction
    // record run atomically inside one Postgres function (profile row locked).
    const { data: reference, error } = await db.rpc('request_withdrawal', {
      p_user: req.session!.uid,
      p_amount: Number(amount),
      p_ref: generateReference(),
      p_min_packages: MIN_DISTINCT_PACKAGES
    });

    if (error) {
      console.error('[withdrawal/request]', error);
      throw new HttpError(400, WITHDRAWAL_ERRORS[rpcMessage(error)] ?? 'Could not process your withdrawal request.');
    }

    await analytics.safeLog('withdrawal_requested', Number(amount), 'withdrawal');
    return { ok: true, reference };
  });

  // Encodes the gatekeeper rules for the client to *render* — enforcement is re-checked atomically in /request.
  app.get('/status', async (req) => {
    const uid = req.session!.uid;
    const [userRes, cfg] = await Promise.all([
      db.from('profiles').select('account_tier, package_status, payout_method, wallet_amount').eq('id', uid).maybeSingle(),
      config.get('withdrawal')
    ]);

    const user = userRes.data;
    const enabledDate = cfg?.enabledDate ? new Date(cfg.enabledDate) : null;

    const dateThresholdReached = !!enabledDate && new Date() >= enabledDate;
    const isUpgraded = user?.account_tier === 'upgraded';
    const hasPaidPackage = !!user?.package_status && user.package_status !== 'Free' && user.package_status !== 'pending verification';
    const distinctPackageCount = hasPaidPackage ? await eligibility.distinctActivePackageCount(uid) : 0;
    const hasEnoughPackages = distinctPackageCount >= MIN_DISTINCT_PACKAGES;

    let reason: string | null = null;
    if (!enabledDate || !dateThresholdReached) reason = "Withdrawal isn't enabled yet. Check back later.";
    else if (!isUpgraded) reason = 'You must upgrade your account to access withdrawals.';
    else if (!hasPaidPackage) reason = 'A paid package is required before you can withdraw.';
    else if (!hasEnoughPackages) reason = `You need at least ${MIN_DISTINCT_PACKAGES} different packages before you can withdraw.`;

    return {
      allowed: !reason,
      reason,
      enabledDate,
      packageStatus: user?.package_status ?? 'Free',
      payoutMethod: user?.payout_method ?? null,
      walletAmount: num(user?.wallet_amount)
    };
  });
};
export default withdrawalRoutes;
