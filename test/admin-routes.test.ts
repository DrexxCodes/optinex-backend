import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, ADMIN_ID, USER_ID, OTHER_ID, type Harness } from './helpers/app';

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  h.db.onRpc('log_analytics_event', () => null);
});
afterEach(async () => h.app.close());

const get = (url: string) => h.app.inject({ method: 'GET', url, headers: h.admin });
const send = (method: 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: any) => h.app.inject({ method, url, payload, headers: h.admin });
const actions = () => h.db.rpcCalls.filter((c) => c.name === 'log_analytics_event').map((c) => c.args.p_action);

describe('overview', () => {
  it('reshapes the single admin_overview RPC', async () => {
    const today = new Date();
    const id = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    h.db.onRpc('admin_overview', () => ({
      totalUsers: 10, freeUsers: 7, upgradedUsers: 3, pendingUpgrades: 1, pendingInvestments: 2, pendingWithdrawals: 3, pendingWithdrawalTotal: 900,
      packages: [{ name: 'Gold', count: 2 }], daily: [{ date: id, signups: 4, revenueTotal: 500, revenueEvents: 2 }],
      monthly: { revenueTotal: 5000, revenueEvents: 9 }, yearly: { revenueTotal: 9000, revenueEvents: 20 }
    }));
    const r = (await get('/api/admin/overview')).json();
    expect(r.totalUsers).toBe(10);
    expect(r.signups).toHaveLength(3);
    expect(r.signups[2]).toEqual({ date: id, signups: 4 });
    expect(r.financial.daily).toEqual({ label: id, amountTotal: 500, total: 2 });
    expect(r.financial.yearly.amountTotal).toBe(9000);
  });
});

describe('users', () => {
  it('searches by email or username and 404s politely', async () => {
    const byEmail = (await get('/api/admin/users?email=UCHE@x.com')).json();
    expect(byEmail.user).toMatchObject({ uid: USER_ID, username: 'uche', admin: false, packageStatus: 'Free', accountTier: 'standard' });
    expect((await get('/api/admin/users?q=obi')).json().user.uid).toBe(OTHER_ID);
    const miss = await get('/api/admin/users?q=nobody');
    expect(miss.statusCode).toBe(404);
    expect(miss.json().error).toBe('No user found with that username.');
    expect((await get('/api/admin/users')).statusCode).toBe(400);
  });

  it('PATCH toggles admin but never lets you demote yourself', async () => {
    expect((await send('PATCH', `/api/admin/users/${USER_ID}`, { admin: 'yes' })).statusCode).toBe(400);
    expect((await send('PATCH', `/api/admin/users/${ADMIN_ID}`, { admin: false })).json().error).toBe("You can't remove your own admin access.");
    expect((await send('PATCH', '/api/admin/users/not-a-uuid', { admin: true })).statusCode).toBe(404);
    expect((await send('PATCH', `/api/admin/users/${USER_ID}`, { admin: true })).json()).toEqual({ ok: true });
    expect(h.db.rows('profiles').find((p) => p.id === USER_ID)!.is_admin).toBe(true);
  });

  it('subscriptions marks only the newest active row of the live package as current', async () => {
    Object.assign(h.db.rows('profiles').find((p) => p.id === USER_ID)!, { package_id: 'p2', package_started_at: Date.now() - 1000, package_expires_at: Date.now() + 100000 });
    h.db.seed('investments', [
      { id: 'i1', user_id: USER_ID, package_id: 'p2', package_name: 'Gold', amount: 20, status: 'active', created_at: '2026-01-01T00:00:00Z' },
      { id: 'i2', user_id: USER_ID, package_id: 'p2', package_name: 'Gold', amount: 20, status: 'active', created_at: '2026-02-01T00:00:00Z' },
      { id: 'i3', user_id: USER_ID, package_id: 'p1', package_name: 'Silver', amount: 10, status: 'weird', created_at: '2026-03-01T00:00:00Z' }
    ]);
    h.db.seed('account_upgrades', [{ id: 'u1', user_id: USER_ID, amount: 3000, status: 'active', created_at: '2026-04-01T00:00:00Z' }]);

    const { subscriptions } = (await get(`/api/admin/users/${USER_ID}/subscriptions`)).json();
    expect(subscriptions.map((s: any) => s.id)).toEqual(['u1', 'i3', 'i2', 'i1']); // newest first
    const byId = Object.fromEntries(subscriptions.map((s: any) => [s.id, s]));
    expect(byId.i2.current).toBe(true);
    expect(byId.i1.current).toBe(false);
    expect(byId.i3.status).toBe('failed'); // unknown statuses normalize to failed
    expect(byId.u1).toMatchObject({ kind: 'upgrade', name: 'Account Upgrade', current: true });
  });

  it('revoke maps RPC outcomes', async () => {
    const url = `/api/admin/users/${USER_ID}/subscriptions/s1`;
    expect((await send('PATCH', url, { kind: 'other' })).statusCode).toBe(400);
    h.db.onRpc('revoke_subscription', () => { throw new Error('NOT_ACTIVE'); });
    expect((await send('PATCH', url, { kind: 'package' })).json().error).toBe('Only active subscriptions can be revoked.');
    h.db.onRpc('revoke_subscription', () => { throw new Error('SUB_NOT_FOUND'); });
    expect((await send('PATCH', url, { kind: 'package' })).statusCode).toBe(404);
    h.db.onRpc('revoke_subscription', () => ({ resetProfile: true }));
    expect((await send('PATCH', url, { kind: 'package' })).json()).toEqual({ ok: true, resetProfile: true });
    expect(h.db.rpcCalls.at(-1)!.args).toMatchObject({ p_user: USER_ID, p_sub: 's1', p_kind: 'package', p_admin: ADMIN_ID });
  });

  it('wallet funding validates the amount and credits atomically', async () => {
    const url = `/api/admin/users/${USER_ID}/wallet`;
    expect((await send('POST', url, { amount: -5 })).statusCode).toBe(400);
    expect((await send('POST', url, { amount: '5' })).statusCode).toBe(400);
    h.db.onRpc('credit_wallet', () => 7500);
    const ok = (await send('POST', url, { amount: 2500, note: ' Bonus ' })).json();
    expect(ok).toMatchObject({ ok: true, walletAmount: 7500 });
    expect(ok.txnRef).toMatch(/^\d{24}$/);
    expect(h.db.rpcCalls.find((c) => c.name === 'credit_wallet')!.args).toMatchObject({ p_user: USER_ID, p_amount: 2500, p_name: 'Bonus' });
    h.db.onRpc('credit_wallet', () => { throw new Error('USER_NOT_FOUND'); });
    expect((await send('POST', url, { amount: 1 })).statusCode).toBe(404);
  });

  it('transactions endpoint returns an empty page for bad ids', async () => {
    expect((await get('/api/admin/users/nope/transactions')).json()).toEqual({ transactions: [], hasMore: false, nextCursor: null });
  });
});

describe('investments', () => {
  it('bank settings round-trip', async () => {
    expect((await get('/api/admin/investments/bank')).json()).toEqual({ bankName: '', accountNumber: '', accountName: '' });
    expect((await send('PUT', '/api/admin/investments/bank', { bankName: 'GT' })).statusCode).toBe(400);
    await send('PUT', '/api/admin/investments/bank', { bankName: 'GT', accountNumber: '1', accountName: 'Inc' });
    expect((await get('/api/admin/investments/bank')).json()).toEqual({ bankName: 'GT', accountNumber: '1', accountName: 'Inc' });
  });

  it('package CRUD', async () => {
    h.db.onRpc('merge_config', () => null);
    expect((await send('POST', '/api/admin/investments/packages', { name: 'X' })).statusCode).toBe(400);
    const created = (await send('POST', '/api/admin/investments/packages', { name: 'Gold', price: 20000, duration: '30d', details: ['a', '', 'b'] })).json();
    expect(created.ok).toBe(true);
    expect(h.db.rows('packages')[0]).toMatchObject({ name: 'Gold', details: ['a', 'b'], active: true });
    expect((await send('PATCH', `/api/admin/investments/packages/${created.id}`, {})).statusCode).toBe(400);
    await send('PATCH', `/api/admin/investments/packages/${created.id}`, { active: false, junk: 1 });
    expect(h.db.rows('packages')[0].active).toBe(false);
    expect((await get('/api/admin/investments/packages')).json().packages[0]).toMatchObject({ name: 'Gold', active: false });
    await send('DELETE', `/api/admin/investments/packages/${created.id}`);
    expect(h.db.rows('packages')).toHaveLength(0);
  });

  it('pending requests carry the owner name, newest first', async () => {
    h.db.seed('investments', [
      { id: 'a', user_id: USER_ID, package_name: 'Gold', amount: 1, receipt_url: 'r', reference: 'x', status: 'pending', created_at: '2026-01-01T00:00:00Z' },
      { id: 'b', user_id: OTHER_ID, package_name: 'Silver', amount: 2, receipt_url: 'r', reference: 'y', status: 'pending', created_at: '2026-02-01T00:00:00Z' },
      { id: 'c', user_id: OTHER_ID, status: 'active', created_at: '2026-03-01T00:00:00Z' }
    ]);
    const { requests } = (await get('/api/admin/investments/requests')).json();
    expect(requests.map((r: any) => [r.id, r.fullName, r.username])).toEqual([['b', 'Obi Other', 'obi'], ['a', 'Uche User', 'uche']]);
  });

  it('approve logs revenue analytics; reject does not; RPC errors map', async () => {
    h.db.onRpc('resolve_investment', () => 20000);
    expect((await send('PATCH', '/api/admin/investments/requests/a', { action: 'nope' })).statusCode).toBe(400);
    await send('PATCH', '/api/admin/investments/requests/a', { action: 'reject' });
    expect(actions()).toEqual([]);
    await send('PATCH', '/api/admin/investments/requests/a', { action: 'approve' });
    expect(actions()).toEqual(['investment_verified']);
    expect(h.db.rpcCalls.find((c) => c.name === 'log_analytics_event')!.args).toMatchObject({ p_amount: 20000, p_revenue: true });

    h.db.onRpc('resolve_investment', () => { throw new Error('RESOLVED'); });
    expect((await send('PATCH', '/api/admin/investments/requests/a', { action: 'approve' })).json().error).toBe('This request has already been resolved.');
    h.db.onRpc('resolve_investment', () => { throw new Error('NOT_FOUND'); });
    expect((await send('PATCH', '/api/admin/investments/requests/a', { action: 'approve' })).statusCode).toBe(404);
  });
});

describe('loans', () => {
  beforeEach(() => {
    h.db.seed('loans', [
      { id: 'l1', user_id: USER_ID, amount: 1000, status: 'pending', reference: 'r1', created_at: '2026-01-01T00:00:00Z' },
      { id: 'l2', user_id: OTHER_ID, amount: 2000, status: 'approved', reference: 'r2', created_at: '2026-02-01T00:00:00Z', full_name: 'Snapshot', username: 'snap' }
    ]);
  });

  it('lists with per-stage counts and an optional filter', async () => {
    const all = (await get('/api/admin/loans')).json();
    expect(all.counts).toEqual({ pending: 1, processing: 0, approved: 1, disbursed: 0 });
    expect(all.loans.map((l: any) => l.id)).toEqual(['l2', 'l1']);
    expect(all.loans[1]).toMatchObject({ fullName: 'Uche User', username: 'uche', amount: 1000 });
    expect((await get('/api/admin/loans?status=pending')).json().loans.map((l: any) => l.id)).toEqual(['l1']);
  });

  it('timeline for one loan, 404 for unknown', async () => {
    h.db.seed('loan_timeline', [{ loan_id: 'l1', status: 'pending', at: '2026-01-01T00:00:00Z', by: 'user' }]);
    expect((await get('/api/admin/loans/l1')).json().timeline[0]).toMatchObject({ status: 'pending', by: 'user' });
    expect((await get('/api/admin/loans/zzz')).statusCode).toBe(404);
  });

  it('only advances exactly one step; stale updates are 409', async () => {
    expect((await send('PATCH', '/api/admin/loans/l1', { from: 'pending', to: 'approved' })).statusCode).toBe(400);
    expect((await send('PATCH', '/api/admin/loans/l1', { from: 'disbursed', to: 'pending' })).statusCode).toBe(400);
    h.db.onRpc('advance_loan', () => null);
    expect((await send('PATCH', '/api/admin/loans/l1', { from: 'pending', to: 'processing' })).json()).toEqual({ ok: true });
    expect(h.db.rpcCalls.find((c) => c.name === 'advance_loan')!.args).toEqual({ p_id: 'l1', p_from: 'pending', p_to: 'processing', p_admin: ADMIN_ID });
    h.db.onRpc('advance_loan', () => { throw new Error('STALE'); });
    expect((await send('PATCH', '/api/admin/loans/l1', { from: 'pending', to: 'processing' })).statusCode).toBe(409);
  });
});

describe('withdrawals & upgrades', () => {
  it('lists pending withdrawals and resolves them', async () => {
    h.db.seed('withdrawals', [{ id: 'w1', user_id: USER_ID, amount: '500', payout_method: { bankName: 'GT' }, reference: 'r', status: 'pending', created_at: '2026-01-01T00:00:00Z' }]);
    expect((await get('/api/admin/withdrawals/requests')).json().requests[0]).toMatchObject({ id: 'w1', amount: 500, fullName: 'Uche User' });
    h.db.onRpc('resolve_withdrawal', () => null);
    expect((await send('PATCH', '/api/admin/withdrawals/requests/w1', { action: 'reject' })).json()).toEqual({ ok: true });
    h.db.onRpc('resolve_withdrawal', () => { throw new Error('RESOLVED'); });
    expect((await send('PATCH', '/api/admin/withdrawals/requests/w1', { action: 'approve' })).statusCode).toBe(400);
  });

  it('withdrawal enable-date setting', async () => {
    expect((await get('/api/admin/withdrawals/settings')).json()).toEqual({ enabledDate: null });
    expect((await send('PUT', '/api/admin/withdrawals/settings', { enabledDate: 'garbage' })).statusCode).toBe(400);
    await send('PUT', '/api/admin/withdrawals/settings', { enabledDate: '2026-06-01' });
    expect((await get('/api/admin/withdrawals/settings')).json().enabledDate).toBe('2026-06-01T00:00:00.000Z');
  });

  it('upgrade approval records revenue; settings validate', async () => {
    h.db.onRpc('resolve_upgrade', () => 3000);
    await send('PATCH', '/api/admin/upgrade/requests/u1', { action: 'approve' });
    expect(actions()).toEqual(['account_upgrade_verified']);
    expect((await send('PUT', '/api/admin/upgrade/settings', { price: 0 })).json().error).toBe('Enter a valid price.');
    expect((await send('PUT', '/api/admin/upgrade/settings', { price: 5 })).statusCode).toBe(400);
    await send('PUT', '/api/admin/upgrade/settings', { price: 5, bankName: 'b', accountNumber: '1', accountName: 'n' });
    expect((await get('/api/admin/upgrade/settings')).json()).toMatchObject({ price: 5, bankName: 'b' });
  });
});

describe('tasks / popup / push', () => {
  it('task CRUD', async () => {
    expect((await send('POST', '/api/admin/tasks', { name: 'n', details: 'd', reward: 0 })).statusCode).toBe(400);
    const id = (await send('POST', '/api/admin/tasks', { name: 'n', details: 'd', reward: 250 })).json().id;
    expect((await get('/api/admin/tasks')).json().tasks[0]).toMatchObject({ id, reward: 250, buttonLabel: '', link: '', active: true });
    await send('PATCH', `/api/admin/tasks/${id}`, { buttonLabel: 'Go', active: false });
    expect(h.db.rows('tasks')[0]).toMatchObject({ button_label: 'Go', active: false });
    expect((await send('PATCH', `/api/admin/tasks/${id}`, {})).statusCode).toBe(400);
    await send('DELETE', `/api/admin/tasks/${id}`);
    expect(h.db.rows('tasks')).toHaveLength(0);
  });

  it('popup validation rules', async () => {
    expect((await send('PUT', '/api/admin/popup', { enabled: true, title: '', body: 'b' })).statusCode).toBe(400);
    expect((await send('PUT', '/api/admin/popup', { enabled: false, actionLabel: 'Go' })).json().error).toBe('Set both an action label and link, or leave both empty.');
    expect((await send('PUT', '/api/admin/popup', { enabled: true, title: ' T ', body: ' B ' })).json()).toEqual({ ok: true });
    expect(h.db.rpcCalls.find((c) => c.name === 'merge_config')!.args.p_value).toEqual({ enabled: true, title: 'T', body: 'B', actionLabel: null, actionLink: null });
    expect((await get('/api/admin/popup')).json()).toEqual({ enabled: true, title: 'T', body: 'B', actionLabel: '', actionLink: '' });
  });

  it('push sends to the platform topic, records history; FCM failure is a 502', async () => {
    expect((await send('POST', '/api/admin/push', { title: 'x' })).statusCode).toBe(400);
    const ok = (await send('POST', '/api/admin/push', { title: ' Hi ', body: ' There ', link: 'https://x.y' })).json();
    expect(ok).toMatchObject({ ok: true, messageId: 'msg-1' });
    expect(h.sent[0]).toMatchObject({ topic: 'platform_all', notification: { title: 'Hi', body: 'There' }, webpush: { fcmOptions: { link: 'https://x.y' } } });
    expect(h.db.rows('push_notifications')[0]).toMatchObject({ title: 'Hi', sent_by: 'admin@x.com' });
    const hist = (await get('/api/admin/push')).json().notifications;
    expect(hist[0]).toMatchObject({ title: 'Hi', body: 'There', sentBy: 'admin@x.com' });

    (h.app.c.messaging as any).send = async () => { throw new Error('fcm'); };
    expect((await send('POST', '/api/admin/push', { title: 't', body: 'b' })).statusCode).toBe(502);
  });
});

describe('leaderboard / referrals / resets', () => {
  it('game leaderboard paginates', async () => {
    for (let i = 1; i <= 12; i++) {
      await h.redis.zadd('casino:leaderboard:stack-tower', { score: i, member: `u${i}` });
      await h.redis.hset('casino:usernames:stack-tower', { [`u${i}`]: `name${i}` });
    }
    const p1 = (await get('/api/admin/leaderboard?game=stack-tower')).json();
    expect(p1.entries).toHaveLength(10);
    expect(p1.entries[0]).toEqual({ rank: 1, uid: 'u12', username: 'name12', score: 12 });
    expect(p1).toMatchObject({ hasMore: true, offset: 0, game: 'stack-tower' });
    const p2 = (await get('/api/admin/leaderboard?game=stack-tower&offset=10')).json();
    expect(p2.entries.map((e: any) => e.rank)).toEqual([11, 12]);
    expect(p2.hasMore).toBe(false);
  });

  it('weekly referral leaderboard + reset', async () => {
    await h.redis.zadd('referral:weekly:leaderboard', { score: 3, member: OTHER_ID });
    await h.redis.zadd('referral:leaderboard', { score: 10, member: OTHER_ID });
    h.db.onRpc('reset_weekly_referrals', () => 4);
    h.db.onRpc('merge_config', () => null);
    const r = (await get('/api/admin/referrals')).json();
    expect(r.leaderboard[0]).toMatchObject({ uid: OTHER_ID, fullName: 'Obi Other', weeklyReferrals: 3, allTimeReferrals: 10, weeklyIncome: 3000, allTimeIncome: 10000, rank: 1 });
    const reset = (await send('POST', '/api/admin/referrals/reset')).json();
    expect(reset).toMatchObject({ ok: true, cleared: 4 });
    expect(h.redis.z.has('referral:weekly:leaderboard')).toBe(false);
    expect(h.redis.z.has('referral:leaderboard')).toBe(true); // all-time untouched
  });

  it('category resets only touch their own fields', async () => {
    h.db.onRpc('reset_analytics_fields', () => null);
    h.db.onRpc('merge_config', () => null);
    expect((await send('POST', '/api/admin/reset', { category: 'bogus' })).statusCode).toBe(400);
    const r = (await send('POST', '/api/admin/reset', { category: 'checkin' })).json();
    expect(r).toMatchObject({ ok: true, category: 'checkin', gameId: null });
    expect(h.db.rpcCalls.find((c) => c.name === 'reset_analytics_fields')!.args.p_fields).toEqual(['counts.checkin']);
    expect(r.resetLog.game['all']).toBeNull();
  });

  it('game reset clears Redis for one game and zeroes DB scores', async () => {
    h.db.onRpc('reset_game_scores', () => null);
    h.db.onRpc('merge_config', () => null);
    await h.redis.zadd('casino:leaderboard:reaction-tap', { score: 5, member: USER_ID });
    await send('POST', '/api/admin/reset', { category: 'game', gameId: 'reaction-tap' });
    expect(h.redis.z.has('casino:leaderboard:reaction-tap')).toBe(false);
    expect(h.db.rpcCalls.find((c) => c.name === 'reset_game_scores')!.args).toEqual({ p_game: 'reaction-tap', p_ids: [USER_ID] });
  });

  it('nuke demands the exact phrase and wipes the Redis boards', async () => {
    h.db.onRpc('nuke_all_users', () => ({ usersDeleted: 5, adminsPreserved: 1, authUsersDeleted: 5 }));
    h.db.onRpc('merge_config', () => null);
    await h.redis.zadd('referral:leaderboard', { score: 1, member: 'x' });
    expect((await send('POST', '/api/admin/reset/nuke', { confirm: 'delete everything' })).statusCode).toBe(400);
    expect((await send('POST', '/api/admin/reset/nuke')).statusCode).toBe(400);
    expect(h.db.rpcCalls.find((c) => c.name === 'nuke_all_users')).toBeUndefined();
    const ok = (await send('POST', '/api/admin/reset/nuke', { confirm: 'DELETE EVERYTHING' })).json();
    expect(ok).toMatchObject({ ok: true, usersDeleted: 5, adminsPreserved: 1, authUsersDeleted: 5 });
    expect(h.redis.z.has('referral:leaderboard')).toBe(false);
  });
});
