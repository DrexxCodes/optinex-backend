import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, USER_ID, OTHER_ID, type Harness } from './helpers/app';

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  h.db.onRpc('log_analytics_event', () => null);
});
afterEach(async () => h.app.close());

const get = (url: string, headers = h.user) => h.app.inject({ method: 'GET', url, headers });
const send = (method: 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: any, headers = h.user) => h.app.inject({ method, url, payload, headers });
const profile = () => h.db.rows('profiles').find((p) => p.id === USER_ID)!;

describe('profile', () => {
  it('GET /api/user/me returns the dashboard shape', async () => {
    const res = await get('/api/user/me');
    expect(res.json()).toEqual({
      uid: USER_ID, fullName: 'Uche User', email: 'uche@x.com', username: 'uche', walletAmount: 5000,
      packageStatus: 'Free', isChangingPackage: false, accountTier: 'standard', upgradeStatus: 'none',
      payoutMethod: null, admin: false, avatarUrl: '/api/avatar/uche%40x.com'
    });
  });

  it('PATCH validates and updates the name', async () => {
    expect((await send('PATCH', '/api/user/me', {})).statusCode).toBe(400);
    expect((await send('PATCH', '/api/user/me', { fullName: 'New Name' })).json()).toEqual({ ok: true });
    expect(profile().full_name).toBe('New Name');
  });
});

describe('popup / notifications / utils', () => {
  it('popup is disabled by default and returns config when enabled', async () => {
    expect((await get('/api/popup')).json()).toEqual({ enabled: false });
    h.db.seed('config', [{ key: 'popup', value: { enabled: true, title: 'Hi', body: 'Yo', actionLabel: 'Go', actionLink: '/x' } }]);
    expect((await get('/api/popup')).json()).toEqual({ enabled: true, title: 'Hi', body: 'Yo', actionLabel: 'Go', actionLink: '/x' });
  });

  it('registers a push token and subscribes it to the platform topic', async () => {
    expect((await send('POST', '/api/notifications/register', {})).statusCode).toBe(400);
    const res = await send('POST', '/api/notifications/register', { token: 'tok-1', deviceId: 'd1' });
    expect(res.json()).toEqual({ ok: true });
    expect(h.db.rows('push_tokens')[0]).toMatchObject({ token: 'tok-1', user_id: USER_ID, device_id: 'd1' });
    expect(h.subscribed).toEqual(['platform_all']);
  });

  it("only the owner can remove a token", async () => {
    h.db.seed('push_tokens', [{ token: 't', user_id: OTHER_ID }]);
    await send('DELETE', '/api/notifications/register', { token: 't' });
    expect(h.db.rows('push_tokens')).toHaveLength(1);
    await send('DELETE', '/api/notifications/register', { token: 't' }, h.as(OTHER_ID));
    expect(h.db.rows('push_tokens')).toHaveLength(0);
  });
});

describe('casino', () => {
  it('submit-score keeps only personal bests and feeds the leaderboard', async () => {
    h.db.onRpc('set_casino_high_score', () => null);
    expect((await send('POST', '/api/casino/submit-score', { score: -1 })).statusCode).toBe(400);
    await send('POST', '/api/casino/submit-score', { score: 50, game: 'reaction-tap' });
    await send('POST', '/api/casino/submit-score', { score: 30, game: 'reaction-tap' }); // worse: ignored
    expect(h.db.rpcCalls.filter((c) => c.name === 'set_casino_high_score')).toHaveLength(1);

    await send('POST', '/api/casino/submit-score', { score: 99, game: 'reaction-tap' }, h.as(OTHER_ID));
    const lb = (await get('/api/casino/leaderboard?game=reaction-tap')).json();
    expect(lb.leaderboard).toEqual([{ rank: 1, username: 'obi', score: 99 }, { rank: 2, username: 'uche', score: 50 }]);
  });

  it('unknown game falls back to brick-slasher', async () => {
    h.db.onRpc('set_casino_high_score', () => null);
    await send('POST', '/api/casino/submit-score', { score: 5, game: 'nonsense' });
    expect(h.redis.z.get('casino:leaderboard:brick-slasher')?.get(USER_ID)).toBe(5);
  });
});

describe('investment', () => {
  beforeEach(() => {
    h.db.seed('packages', [
      { id: 'p2', name: 'Gold', price: 20000, duration: '30d', details: ['a'], active: true },
      { id: 'p1', name: 'Silver', price: 10000, duration: '30d', details: null, active: true },
      { id: 'p3', name: 'Hidden', price: 1, duration: '1d', details: [], active: false }
    ]);
  });

  it('lists active packages cheapest first', async () => {
    const { packages } = (await get('/api/investment/packages')).json();
    expect(packages).toEqual([
      { id: 'p1', name: 'Silver', price: 10000, duration: '30d', details: [] },
      { id: 'p2', name: 'Gold', price: 20000, duration: '30d', details: ['a'] }
    ]);
  });

  it('subscribe creates a pending request and flips package status', async () => {
    expect((await send('POST', '/api/investment/subscribe', {})).statusCode).toBe(400);
    expect((await send('POST', '/api/investment/subscribe', { packageId: 'nope', receiptUrl: 'u' })).statusCode).toBe(404);

    const res = await send('POST', '/api/investment/subscribe', { packageId: 'p1', receiptUrl: 'https://r/1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().reference).toMatch(/^\d{24}$/);
    expect(h.db.rows('investments')[0]).toMatchObject({ user_id: USER_ID, package_id: 'p1', amount: 10000, status: 'pending' });
    expect(profile().package_status).toBe('pending verification');
    expect(h.db.rpcCalls.some((c) => c.args.p_action === 'investment_submitted' && c.args.p_amount === 10000)).toBe(true);
  });

  it('change-package requires an active package', async () => {
    const free = await send('POST', '/api/investment/change-package', { packageId: 'p2', receiptUrl: 'u' });
    expect(free.statusCode).toBe(400);
    Object.assign(profile(), { package_status: 'Active', package_id: 'p1' });
    const ok = await send('POST', '/api/investment/change-package', { packageId: 'p2', receiptUrl: 'u' });
    expect(ok.statusCode).toBe(200);
    expect(h.db.rows('investments')[0]).toMatchObject({ is_package_change: true, previous_package_id: 'p1' });
    expect(profile()).toMatchObject({ package_status: 'pending verification', is_changing_package: true });
  });

  it('status exposes bank details and the latest request', async () => {
    h.db.seed('config', [{ key: 'bank', value: { bankName: 'GT', accountNumber: '1', accountName: 'Inc' } }]);
    await send('POST', '/api/investment/subscribe', { packageId: 'p1', receiptUrl: 'u' });
    const s = (await get('/api/investment/status')).json();
    expect(s.bank).toEqual({ bankName: 'GT', accountNumber: '1', accountName: 'Inc' });
    expect(s.latestRequest).toMatchObject({ packageId: 'p1', status: 'pending', amount: 10000 });
    expect(s.packageStatus).toBe('pending verification');
  });
});

describe('loans', () => {
  const form = {
    reason: 'Expand my small business inventory', amount: 50000, occupation: 'Trader', phone: '08031234567',
    address: '12 Market Road, Port Harcourt', nextOfKinName: 'Chi Eze', nextOfKinPhone: '+2348051234567', accountNumber: '0123456789', bankCode: '058'
  };

  it('GET reports why a standard account is blocked', async () => {
    h.db.onRpc('distinct_active_package_count', () => 0);
    const r = (await get('/api/loans')).json();
    expect(r).toMatchObject({ allowed: false, blockCode: 'UPGRADE_REQUIRED', hasPending: false, limits: { min: 1000, max: 5000000 }, loans: [] });
  });

  it('GET lists loans with a 4-step timeline', async () => {
    Object.assign(profile(), { account_tier: 'upgraded' });
    h.db.onRpc('distinct_active_package_count', () => 2);
    h.db.seed('loans', [{ id: 'l1', user_id: USER_ID, amount: 1000, status: 'pending', reference: 'r', bank_account: {}, created_at: '2026-01-01T00:00:00Z' }]);
    h.db.seed('loan_timeline', [{ loan_id: 'l1', status: 'pending', at: '2026-01-01T00:00:00Z', by: 'user' }]);
    const r = (await get('/api/loans')).json();
    expect(r.allowed).toBe(true);
    expect(r.hasPending).toBe(true);
    expect(r.loans[0].timeline.map((t: any) => t.status)).toEqual(['pending', 'processing', 'approved', 'disbursed']);
    expect(r.loans[0].timeline[0]).toMatchObject({ reachedAt: '2026-01-01T00:00:00.000Z', by: 'user' });
  });

  it('apply validates the form server-side', async () => {
    expect((await send('POST', '/api/loans/apply', { ...form, amount: 5 })).json().error).toMatch(/whole-naira amount/);
    expect((await send('POST', '/api/loans/apply', { ...form, nextOfKinPhone: form.phone })).json().error).toMatch(/must be different/);
  });

  it('apply is blocked for non-upgraded accounts, and succeeds for eligible ones', async () => {
    h.db.onRpc('distinct_active_package_count', () => 2);
    h.db.onRpc('create_loan', () => 'loan-1');
    const blocked = await send('POST', '/api/loans/apply', form);
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toMatch(/upgrade your account/);

    Object.assign(profile(), { account_tier: 'upgraded' });
    const ok = await send('POST', '/api/loans/apply', form);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, loanId: 'loan-1' });
    const args = h.db.rpcCalls.find((c) => c.name === 'create_loan')!.args;
    expect(args.p_bank).toEqual({ accountNumber: '0123456789', bankCode: '058', bankName: 'GTBank', accountName: 'ADA EZE' });
    expect(args.p_applicant).toMatchObject({ phone: '08031234567', email: 'uche@x.com' }); // identity from the account, not the request
    expect(args.p_next_of_kin.phone).toBe('08051234567'); // normalized
  });

  it('apply surfaces the pending-lock error and unresolved accounts', async () => {
    Object.assign(profile(), { account_tier: 'upgraded' });
    h.db.onRpc('distinct_active_package_count', () => 2);
    h.db.onRpc('create_loan', () => { throw new Error('PENDING_EXISTS'); });
    expect((await send('POST', '/api/loans/apply', form)).json().error).toMatch(/already have a pending/);
    const bad = await send('POST', '/api/loans/apply', { ...form, accountNumber: '0000000000' });
    expect(bad.statusCode).toBe(422);
  });

  it('apply is capped at 5 per hour per user', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await send('POST', '/api/loans/apply', { ...form, amount: 5 })).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 400)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });
});

describe('referral', () => {
  it('GET returns key, connections and recent connections', async () => {
    Object.assign(profile(), { referral_key: 'incossify-abc123', referral_earnings: 4000 });
    h.db.seed('profiles', [{ id: 'c1', full_name: 'Kid One', username: 'kid1', referred_by: USER_ID, created_at: '2026-02-01T00:00:00Z' }]);
    const r = (await get('/api/referral')).json();
    expect(r).toEqual({
      referralKey: 'incossify-abc123', connections: 1, totalEarned: 4000,
      recentConnections: [{ uid: 'c1', fullName: 'Kid One', username: 'kid1', joinedAt: '2026-02-01T00:00:00.000Z' }]
    });
  });

  it('generate is idempotent and mints a key once', async () => {
    const a = (await send('POST', '/api/referral/generate')).json();
    expect(a.referralKey).toMatch(/^incossify-[a-z0-9]{6}$/);
    expect((await send('POST', '/api/referral/generate')).json()).toEqual(a);
  });

  it('leaderboard merges Redis ranks with DB names/earnings and reports "you"', async () => {
    await h.redis.zadd('referral:leaderboard', { score: 7, member: OTHER_ID });
    await h.redis.zadd('referral:leaderboard', { score: 3, member: USER_ID });
    Object.assign(profile(), { referral_earnings: 6000 });
    const r = (await get('/api/referral/leaderboard')).json();
    expect(r.leaderboard.map((e: any) => [e.rank, e.username, e.referrals])).toEqual([[1, 'obi', 7], [2, 'uche', 3]]);
    expect(r.you).toEqual({ rank: 2, referrals: 3, totalEarned: 6000 });
    expect(h.redis.h.get('referral:names')?.[OTHER_ID]).toContain('Obi Other'); // cache backfilled
  });
});

describe('streak', () => {
  it('check-in returns the reward, or 409 with nextAvailableAt', async () => {
    h.db.onRpc('daily_checkin', () => ({ already: false, reward: 1000, txn_ref: 'T1' }));
    expect((await send('POST', '/api/streak/checkin')).json()).toEqual({ ok: true, reward: 1000, txnRef: 'T1' });
    h.db.onRpc('daily_checkin', () => ({ already: true, next_available_at: '2026-01-02T00:00:00Z' }));
    const dup = await send('POST', '/api/streak/checkin');
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: 'Already checked in.', nextAvailableAt: '2026-01-02T00:00:00Z' });
  });

  it('history computes canCheckIn from the 24h cycle', async () => {
    Object.assign(profile(), { last_checkin_at: new Date(Date.now() - 3600_000).toISOString(), streak_count: 4 });
    h.db.seed('checkins', [{ id: 1, user_id: USER_ID, date: '2026-01-01', created_at: '2026-01-01T10:00:00Z' }]);
    const r = (await get('/api/streak/history')).json();
    expect(r.canCheckIn).toBe(false);
    expect(r.streakCount).toBe(4);
    expect(r.history).toEqual([{ id: '1', date: '2026-01-01', timestamp: '2026-01-01T10:00:00.000Z' }]);
  });

  it('spin maps RPC errors', async () => {
    h.db.onRpc('spin', (a) => ({ prize_id: a.p_prize_id, amount: a.p_amount, label: a.p_label, spins_left: 2 }));
    const ok = await send('POST', '/api/streak/spin');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ok).toBe(true);
    expect(h.db.rpcCalls.find((c) => c.name === 'spin')!.args.p_max).toBe(3);
    h.db.onRpc('spin', () => { throw new Error('NO_SPINS_LEFT'); });
    const none = await send('POST', '/api/streak/spin');
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe("You're out of spins for today.");
  });

  it('spin/status resets on a new day', async () => {
    Object.assign(profile(), { spins_used: 3, spins_date: '1999-01-01' });
    expect((await get('/api/streak/spin/status')).json()).toEqual({ spinsLeft: 3, maxSpins: 3 });
    Object.assign(profile(), { spins_used: 2, spins_date: new Date().toISOString().slice(0, 10) });
    expect((await get('/api/streak/spin/status')).json()).toEqual({ spinsLeft: 1, maxSpins: 3 });
  });
});

describe('tasks', () => {
  it('hides completed tasks and maps task completion errors', async () => {
    h.db.seed('tasks', [
      { id: 't1', name: 'A', details: 'd', button_label: 'Go', link: 'l', reward: '500', active: true, created_at: 1 },
      { id: 't2', name: 'B', details: 'd', button_label: '', link: '', reward: 100, active: true, created_at: 2 }
    ]);
    h.db.seed('completed_tasks', [{ user_id: USER_ID, task_id: 't1' }]);
    const { tasks } = (await get('/api/tasks')).json();
    expect(tasks.map((t: any) => t.id)).toEqual(['t2']);

    h.db.onRpc('complete_task', () => 500);
    expect((await send('POST', '/api/tasks/t2/complete')).json()).toEqual({ ok: true, reward: 500 });
    h.db.onRpc('complete_task', () => { throw new Error('ALREADY_COMPLETED'); });
    expect((await send('POST', '/api/tasks/t2/complete')).statusCode).toBe(409);
    h.db.onRpc('complete_task', () => { throw new Error('TASK_UNAVAILABLE'); });
    expect((await send('POST', '/api/tasks/t2/complete')).statusCode).toBe(410);
  });
});

describe('upgrade', () => {
  it('status + subscribe flow', async () => {
    h.db.seed('config', [{ key: 'upgrade', value: { price: 3000, bankName: 'GT', accountNumber: '1', accountName: 'Inc' } }]);
    expect((await get('/api/upgrade/status')).json()).toMatchObject({ price: 3000, accountTier: 'standard', upgradeStatus: 'none', latestRequest: null });

    expect((await send('POST', '/api/upgrade/subscribe', {})).statusCode).toBe(400);
    const ok = await send('POST', '/api/upgrade/subscribe', { receiptUrl: 'u' });
    expect(ok.statusCode).toBe(200);
    expect(profile().upgrade_status).toBe('pending');
    const dup = await send('POST', '/api/upgrade/subscribe', { receiptUrl: 'u' });
    expect(dup.json().error).toBe('You already have an upgrade request pending verification.');
  });
});

describe('wallet', () => {
  it('paginates newest first with a cursor', async () => {
    h.db.seed('wallet_transactions', [1, 2, 3].map((id) => ({ id, user_id: USER_ID, txn_type: 'credit', txn_name: 'n' + id, amount: id * 100, txn_ref: 'r' + id, created_at: '2026-01-01T00:00:00Z' })));
    const p1 = (await get('/api/wallet/transactions?limit=2')).json();
    expect(p1.transactions.map((t: any) => t.id)).toEqual(['3', '2']);
    expect(p1).toMatchObject({ hasMore: true, nextCursor: '2' });
    const p2 = (await get('/api/wallet/transactions?limit=2&cursor=2')).json();
    expect(p2.transactions.map((t: any) => t.id)).toEqual(['1']);
    expect(p2).toMatchObject({ hasMore: false, nextCursor: null });
  });
});

describe('withdrawal', () => {
  it('banks come from Paystack; failure is a 502', async () => {
    expect((await get('/api/withdrawal/banks')).json()).toEqual({ banks: [{ code: '058', name: 'GTBank' }, { code: '044', name: 'Access' }] });
    h.paystack.fetchBanks = async () => null as any;
    expect((await get('/api/withdrawal/banks')).statusCode).toBe(502);
  });

  it('resolve-account validates, resolves and is rate-limited (10/min)', async () => {
    expect((await send('POST', '/api/withdrawal/resolve-account', {})).statusCode).toBe(400);
    expect((await send('POST', '/api/withdrawal/resolve-account', { accountNumber: '0123456789', bankCode: '058' })).json()).toEqual({ accountName: 'ADA EZE' });
    const bad = await send('POST', '/api/withdrawal/resolve-account', { accountNumber: '0000000000', bankCode: '058' });
    expect(bad.statusCode).toBe(422);
    for (let i = 0; i < 8; i++) await send('POST', '/api/withdrawal/resolve-account', { accountNumber: '0123456789', bankCode: '058' });
    expect((await send('POST', '/api/withdrawal/resolve-account', { accountNumber: '0123456789', bankCode: '058' })).statusCode).toBe(429);
  });

  it('payout-method saves exactly the four fields', async () => {
    expect((await send('POST', '/api/withdrawal/payout-method', { accountNumber: '1' })).statusCode).toBe(400);
    await send('POST', '/api/withdrawal/payout-method', { accountNumber: '1', bankCode: '2', bankName: 'B', accountName: 'N', evil: 'x' });
    expect(profile().payout_method).toEqual({ accountNumber: '1', bankCode: '2', bankName: 'B', accountName: 'N' });
  });

  it('request translates gatekeeper codes into friendly 400s', async () => {
    expect((await send('POST', '/api/withdrawal/request', { amount: 0 })).statusCode).toBe(400);
    h.db.onRpc('request_withdrawal', () => { throw new Error('UPGRADE_REQUIRED'); });
    const r = await send('POST', '/api/withdrawal/request', { amount: 500 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('You must upgrade your account to access withdrawals.');
    h.db.onRpc('request_withdrawal', () => 'REF123');
    expect((await send('POST', '/api/withdrawal/request', { amount: 500 })).json()).toEqual({ ok: true, reference: 'REF123' });
  });

  it('status encodes each gatekeeper rule in order', async () => {
    h.db.onRpc('distinct_active_package_count', () => 2);
    expect((await get('/api/withdrawal/status')).json()).toMatchObject({ allowed: false, reason: "Withdrawal isn't enabled yet. Check back later." });
    h.db.seed('config', [{ key: 'withdrawal', value: { enabledDate: '2020-01-01T00:00:00Z' } }]);
    expect((await get('/api/withdrawal/status')).json().reason).toBe('You must upgrade your account to access withdrawals.');
    Object.assign(profile(), { account_tier: 'upgraded' });
    expect((await get('/api/withdrawal/status')).json().reason).toBe('A paid package is required before you can withdraw.');
    Object.assign(profile(), { package_status: 'Active' });
    h.db.onRpc('distinct_active_package_count', () => 1);
    expect((await get('/api/withdrawal/status')).json().reason).toBe('You need at least 2 different packages before you can withdraw.');
    h.db.onRpc('distinct_active_package_count', () => 2);
    expect((await get('/api/withdrawal/status')).json()).toMatchObject({ allowed: true, reason: null, walletAmount: 5000 });
  });
});
