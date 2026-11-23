import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers/app';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => h.app.close());

// Every route the old Next.js apps exposed, minus the public ones. Table-driven so a forgotten guard fails CI.
const USER_ROUTES: [string, string][] = [
  ['GET', '/api/user/me'], ['PATCH', '/api/user/me'], ['GET', '/api/popup'],
  ['POST', '/api/notifications/register'], ['DELETE', '/api/notifications/register'],
  ['GET', '/api/utils/ref-generator'], ['GET', '/api/casino/leaderboard'], ['POST', '/api/casino/submit-score'],
  ['GET', '/api/investment/packages'], ['GET', '/api/investment/status'], ['POST', '/api/investment/subscribe'], ['POST', '/api/investment/change-package'],
  ['GET', '/api/loans'], ['POST', '/api/loans/apply'],
  ['GET', '/api/referral'], ['POST', '/api/referral/generate'], ['GET', '/api/referral/leaderboard'],
  ['POST', '/api/streak/checkin'], ['GET', '/api/streak/history'], ['POST', '/api/streak/spin'], ['GET', '/api/streak/spin/status'],
  ['GET', '/api/tasks'], ['POST', '/api/tasks/abc/complete'],
  ['GET', '/api/upgrade/status'], ['POST', '/api/upgrade/subscribe'],
  ['GET', '/api/wallet/transactions'],
  ['GET', '/api/withdrawal/banks'], ['POST', '/api/withdrawal/resolve-account'], ['POST', '/api/withdrawal/payout-method'],
  ['POST', '/api/withdrawal/request'], ['GET', '/api/withdrawal/status']
];

const ADMIN_ROUTES: [string, string][] = [
  ['GET', '/api/admin/overview'], ['GET', '/api/admin/users?email=a@b.c'], ['PATCH', '/api/admin/users/x'],
  ['GET', '/api/admin/users/x/subscriptions'], ['PATCH', '/api/admin/users/x/subscriptions/y'],
  ['GET', '/api/admin/users/x/transactions'], ['POST', '/api/admin/users/x/wallet'],
  ['GET', '/api/admin/investments/bank'], ['PUT', '/api/admin/investments/bank'],
  ['GET', '/api/admin/investments/packages'], ['POST', '/api/admin/investments/packages'],
  ['PATCH', '/api/admin/investments/packages/x'], ['DELETE', '/api/admin/investments/packages/x'],
  ['GET', '/api/admin/investments/requests'], ['PATCH', '/api/admin/investments/requests/x'],
  ['GET', '/api/admin/loans'], ['GET', '/api/admin/loans/x'], ['PATCH', '/api/admin/loans/x'],
  ['GET', '/api/admin/withdrawals/requests'], ['PATCH', '/api/admin/withdrawals/requests/x'],
  ['GET', '/api/admin/withdrawals/settings'], ['PUT', '/api/admin/withdrawals/settings'],
  ['GET', '/api/admin/upgrade/requests'], ['PATCH', '/api/admin/upgrade/requests/x'],
  ['GET', '/api/admin/upgrade/settings'], ['PUT', '/api/admin/upgrade/settings'],
  ['GET', '/api/admin/tasks'], ['POST', '/api/admin/tasks'], ['PATCH', '/api/admin/tasks/x'], ['DELETE', '/api/admin/tasks/x'],
  ['GET', '/api/admin/popup'], ['PUT', '/api/admin/popup'], ['GET', '/api/admin/push'], ['POST', '/api/admin/push'],
  ['GET', '/api/admin/leaderboard'], ['GET', '/api/admin/referrals'], ['POST', '/api/admin/referrals/reset'],
  ['GET', '/api/admin/reset'], ['POST', '/api/admin/reset'], ['POST', '/api/admin/reset/nuke']
];

describe('authentication', () => {
  it.each(USER_ROUTES)('%s %s -> 401 without a session', async (method, url) => {
    const res = await h.app.inject({ method: method as any, url });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthenticated.' });
  });

  it.each(USER_ROUTES)('%s %s -> 401 with a forged token', async (method, url) => {
    const res = await h.app.inject({ method: method as any, url, headers: { cookie: 'optinex_at=forged.token.value' } });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a Bearer token as well as the cookie', async () => {
    const t = h.auth.tokensFor('22222222-2222-4222-8222-000000000002');
    const res = await h.app.inject({ method: 'GET', url: '/api/utils/ref-generator', headers: { authorization: `Bearer ${t.accessToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().reference).toMatch(/^\d{24}$/);
  });
});

describe('admin authorization', () => {
  it.each(ADMIN_ROUTES)('%s %s -> 401 without a session', async (method, url) => {
    expect((await h.app.inject({ method: method as any, url })).statusCode).toBe(401);
  });

  it.each(ADMIN_ROUTES)('%s %s -> 403 for a signed-in NON-admin', async (method, url) => {
    const res = await h.app.inject({ method: method as any, url, headers: h.user });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden.' });
  });

  it('nuke can never be reached by a non-admin even with the right phrase', async () => {
    h.db.onRpc('nuke_all_users', () => { throw new Error('should not run'); });
    const res = await h.app.inject({ method: 'POST', url: '/api/admin/reset/nuke', headers: h.user, payload: { confirm: 'DELETE EVERYTHING' } });
    expect(res.statusCode).toBe(403);
    expect(h.db.rpcCalls.find((c) => c.name === 'nuke_all_users')).toBeUndefined();
  });

  it('a demotion takes effect immediately (admin flag is checked live)', async () => {
    h.db.onRpc('admin_overview', () => ({ totalUsers: 1 }));
    expect((await h.app.inject({ method: 'GET', url: '/api/admin/overview', headers: h.admin })).statusCode).toBe(200);
    h.db.rows('profiles').find((p) => p.id === '22222222-2222-4222-8222-000000000001')!.is_admin = false;
    expect((await h.app.inject({ method: 'GET', url: '/api/admin/overview', headers: h.admin })).statusCode).toBe(403);
  });
});

describe('abuse protection', () => {
  it('public avatar route works without auth and sets long-lived cache headers', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/avatar/' + encodeURIComponent('Uche@X.com') });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.body).toContain('<svg');
  });

  it('avatar seeds are length-limited', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/avatar/' + 'a'.repeat(300) });
    expect(res.statusCode).toBe(400);
  });

  it('global per-IP limit returns 429 with the { error } shape and Retry-After', async () => {
    const h2 = await makeHarness({ RATE_LIMIT_GLOBAL_MAX: '5' });
    const codes: number[] = [];
    let last: any;
    for (let i = 0; i < 8; i++) { last = await h2.app.inject({ method: 'GET', url: '/api/avatar/a' }); codes.push(last.statusCode); }
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes.slice(5).every((c) => c === 429)).toBe(true);
    expect(last.json().error).toMatch(/Too many requests/);
    expect(last.headers['retry-after']).toBeDefined();
    await h2.app.close();
  });

  it('health check is exempt from rate limiting', async () => {
    const h2 = await makeHarness({ RATE_LIMIT_GLOBAL_MAX: '2' });
    for (let i = 0; i < 6; i++) expect((await h2.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await h2.app.close();
  });

  it('per-user limit applies to authenticated routes', async () => {
    const h2 = await makeHarness({ RATE_LIMIT_USER_MAX: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await h2.app.inject({ method: 'GET', url: '/api/utils/ref-generator', headers: h2.user })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    await h2.app.close();
  });

  it('rejects oversized bodies (413) in the standard error shape', async () => {
    const h2 = await makeHarness({ BODY_LIMIT_BYTES: '200' });
    const res = await h2.app.inject({ method: 'POST', url: '/api/auth/signin', payload: { email: 'a@b.c', password: 'x'.repeat(500) } });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'Request body too large.' });
    await h2.app.close();
  });

  it('malformed JSON is a 400 { error }, not a 500', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/auth/signin', headers: { 'content-type': 'application/json' }, payload: '{not json' });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json().error).toBe('string');
  });

  it('unknown routes are a JSON 404', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found.' });
  });

  it('sets security headers and never leaks the framework', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('unexpected errors are logged and returned as a generic 500', async () => {
    h.db.onRpc('admin_overview', () => { throw new Error('secret internal detail'); });
    const res = await h.app.inject({ method: 'GET', url: '/api/admin/overview', headers: h.admin });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret internal detail');
  });
});

describe('cron endpoint', () => {
  it('requires the CRON_SECRET bearer token', async () => {
    const none = await h.app.inject({ method: 'POST', url: '/api/cron/investment-returns' });
    const wrong = await h.app.inject({ method: 'POST', url: '/api/cron/investment-returns', headers: { authorization: 'Bearer nope' } });
    expect(none.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);

    h.db.onRpc('legacy_investment_cron', () => ({ processed: 4, errors: 1 }));
    const ok = await h.app.inject({ method: 'POST', url: '/api/cron/investment-returns', headers: { authorization: 'Bearer cron-secret' } });
    expect(ok.json()).toEqual({ success: true, processed: 4, errors: 1, message: 'Processed 4 users, 1 errors' });
  });

  it('has no localhost bypass', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/cron/investment-returns', remoteAddress: '127.0.0.1', headers: { host: 'localhost:4000' } });
    expect(res.statusCode).toBe(401);
  });

  it('is closed entirely when CRON_SECRET is not configured', async () => {
    const h2 = await makeHarness();
    (h2.app.c.env as any).CRON_SECRET = undefined;
    const res = await h2.app.inject({ method: 'POST', url: '/api/cron/investment-returns', headers: { authorization: 'Bearer undefined' } });
    expect(res.statusCode).toBe(401);
    await h2.app.close();
  });
});
