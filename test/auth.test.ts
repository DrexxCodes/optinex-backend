import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, USER_ID, ADMIN_ID, OTHER_ID, type Harness } from './helpers/app';

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  h.db.onRpc('log_analytics_event', () => null);
});
afterEach(async () => h.app.close());

const post = (url: string, payload?: any, headers: Record<string, string> = {}) =>
  h.app.inject({ method: 'POST', url, payload, headers: { 'x-forwarded-for': '1.1.1.1', ...headers } });

describe('POST /api/auth/signin', () => {
  it('signs in, sets httpOnly session cookies and returns the public user', async () => {
    const res = await post('/api/auth/signin', { email: ' Uche@X.com ', password: 'secret1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { uid: USER_ID, fullName: 'Uche User', email: 'uche@x.com', username: 'uche' } });

    const names = res.cookies.map((c) => c.name).sort();
    expect(names).toEqual(['optinex_at', 'optinex_rt']);
    for (const c of res.cookies) {
      expect(c.httpOnly).toBe(true);
      expect(c.sameSite).toBe('Lax');
      expect(c.path).toBe('/');
    }
    // Tokens never appear in the JSON body.
    expect(res.body).not.toContain('at.');
  });

  it('logs a signin analytics event', async () => {
    await post('/api/auth/signin', { email: 'uche@x.com', password: 'secret1' });
    expect(h.db.rpcCalls.some((c) => c.name === 'log_analytics_event' && c.args.p_action === 'signin')).toBe(true);
  });

  it('catches the user up on investment returns at sign-in', async () => {
    const day = 24 * 3600 * 1000;
    Object.assign(h.db.rows('profiles').find((p) => p.id === USER_ID)!, {
      package_id: 'pkg1', package_status: 'Active', package_started_at: Date.now() - 3 * day - 1000, package_expires_at: Date.now() + 30 * day
    });
    h.db.seed('packages', [{ id: 'pkg1', price: 10000 }]);
    h.db.onRpc('credit_investment_returns', () => 3000);

    await post('/api/auth/signin', { email: 'uche@x.com', password: 'secret1' });
    const call = h.db.rpcCalls.find((c) => c.name === 'credit_investment_returns');
    expect(call?.args).toMatchObject({ p_user: USER_ID, p_days: 3, p_daily: 1000, p_package_id: 'pkg1' });
  });

  it('still signs in when the investment sync blows up', async () => {
    Object.assign(h.db.rows('profiles').find((p) => p.id === USER_ID)!, { package_id: 'pkg1', package_status: 'Active', package_started_at: 1 });
    h.db.seed('packages', [{ id: 'pkg1', price: 10000 }]);
    // credit_investment_returns unhandled -> error -> swallowed
    const res = await post('/api/auth/signin', { email: 'uche@x.com', password: 'secret1' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects bad credentials with 401 and no cookies', async () => {
    const res = await post('/api/auth/signin', { email: 'uche@x.com', password: 'nope' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Invalid email or password.' });
    expect(res.cookies).toHaveLength(0);
  });

  it('requires email and password', async () => {
    const res = await post('/api/auth/signin', { email: 'a@b.c' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Email and password are required.');
  });

  it('maps upstream rate-limit and outage statuses', async () => {
    h.auth.forceSignInStatus = 429;
    expect((await post('/api/auth/signin', { email: 'a@b.c', password: 'x' })).json().error).toMatch(/Too many attempts/);
    h.auth.forceSignInStatus = 503;
    const r = await post('/api/auth/signin', { email: 'a@b.c', password: 'x' });
    expect(r.statusCode).toBe(500);
    expect(r.json().error).toBe('Something went wrong signing you in.');
  });

  it('401s (and signs out) when the auth user has no profile row', async () => {
    h.auth.addUser({ id: 'ghost', email: 'ghost@x.com', password: 'secret1', username: 'ghost' });
    const res = await post('/api/auth/signin', { email: 'ghost@x.com', password: 'secret1' });
    expect(res.statusCode).toBe(401);
    expect(h.auth.signedOut).toHaveLength(1);
  });

  it('limits attempts per email across IPs (credential stuffing)', async () => {
    const h2 = await makeHarness({ RATE_LIMIT_SIGNIN_EMAIL_MAX: '3' });
    h2.db.onRpc('log_analytics_event', () => null);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await h2.app.inject({ method: 'POST', url: '/api/auth/signin', payload: { email: 'uche@x.com', password: 'bad' }, headers: { 'x-forwarded-for': `9.9.9.${i}` } });
      codes.push(r.statusCode);
    }
    // trustProxy is off in tests, so every request shares one IP; the email limiter is what trips.
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);
    await h2.app.close();
  });

  it('applies a per-IP cap and then bans the client (bots)', async () => {
    const h2 = await makeHarness({ RATE_LIMIT_SIGNIN_MAX: '2', RATE_LIMIT_BAN_AFTER: '2', RATE_LIMIT_SIGNIN_EMAIL_MAX: '1000' });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push((await h2.app.inject({ method: 'POST', url: '/api/auth/signin', payload: { email: `x${i}@x.com`, password: 'bad' } })).statusCode);
    }
    expect(codes.slice(0, 2)).toEqual([401, 401]);
    expect(codes.slice(2)).toContain(429);
    expect(codes).toContain(403); // banned after repeated over-limit hits
    await h2.app.close();
  });
});

describe('POST /api/auth/signup', () => {
  const body = { fullName: 'New Person', email: 'New@X.com', username: 'NewGuy', password: 'abcdef' };

  it('creates the account, runs referral side effects and signs the user in', async () => {
    h.db.onRpc('create_profile', () => ({ referrer_id: OTHER_ID, referrer_full_name: 'Obi Other', referrer_username: 'obi' }));
    const res = await post('/api/auth/signup', { ...body, referralKey: 'incossify-abc123' });

    expect(res.statusCode).toBe(200);
    expect(res.json().signedIn).toBe(true);
    expect(res.json().user).toMatchObject({ fullName: 'New Person', email: 'new@x.com', username: 'newguy' });
    expect(res.cookies.map((c) => c.name).sort()).toEqual(['optinex_at', 'optinex_rt']);

    const cp = h.db.rpcCalls.find((c) => c.name === 'create_profile')!;
    expect(cp.args).toMatchObject({ p_email: 'new@x.com', p_username: 'newguy', p_referral_key: 'incossify-abc123', p_bonus: 2000 });
    expect(h.redis.z.get('referral:leaderboard')?.get(OTHER_ID)).toBe(1);
    expect(h.redis.z.get('referral:weekly:leaderboard')?.get(OTHER_ID)).toBe(1);
    const actions = h.db.rpcCalls.filter((c) => c.name === 'log_analytics_event').map((c) => c.args.p_action);
    expect(actions).toEqual(['referral_bonus', 'signup']);
  });

  it('validates input', async () => {
    expect((await post('/api/auth/signup', { email: 'a@b.c' })).json().error).toBe('Full name, email, username, and password are required.');
    expect((await post('/api/auth/signup', { ...body, password: '123' })).json().error).toBe('Password must be at least 6 characters.');
  });

  it('409s on an existing email or username', async () => {
    const e = await post('/api/auth/signup', { ...body, email: 'uche@x.com' });
    expect(e.statusCode).toBe(409);
    expect(e.json().error).toBe('An account with this email already exists.');
    const u = await post('/api/auth/signup', { ...body, username: 'uche' });
    expect(u.json().error).toBe('That username is already taken.');
  });

  it('rolls back the auth user if the profile RPC fails', async () => {
    h.db.onRpc('create_profile', () => { throw new Error('boom'); });
    const res = await post('/api/auth/signup', body);
    expect(res.statusCode).toBe(500);
    expect(h.auth.deleted).toHaveLength(1);
    expect(res.cookies).toHaveLength(0);
  });
});

describe('POST /api/auth/refresh', () => {
  it('401s without a refresh cookie', async () => {
    const res = await post('/api/auth/refresh');
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Session expired.');
  });

  it('rotates both cookies', async () => {
    const res = await post('/api/auth/refresh', undefined, h.user);
    expect(res.statusCode).toBe(200);
    expect(res.cookies.map((c) => c.name).sort()).toEqual(['optinex_at', 'optinex_rt']);
  });

  it('clears cookies when the refresh token is rejected', async () => {
    h.auth.forceRefreshStatus = 400;
    const res = await post('/api/auth/refresh', undefined, h.user);
    expect(res.statusCode).toBe(401);
    expect(res.cookies.every((c) => c.value === '')).toBe(true);
  });

  it('does NOT log the user out when Supabase is down (503, cookies kept)', async () => {
    h.auth.forceRefreshStatus = 502;
    const res = await post('/api/auth/refresh', undefined, h.user);
    expect(res.statusCode).toBe(503);
    expect(res.cookies).toHaveLength(0);
  });
});

describe('logout / session / claim-admin', () => {
  it('logout clears cookies and signs out server-side', async () => {
    const res = await post('/api/auth/logout', undefined, h.user);
    expect(res.statusCode).toBe(200);
    expect(res.cookies.every((c) => c.value === '')).toBe(true);
    expect(h.auth.signedOut).toHaveLength(1);
  });

  it('GET /session reports admin flag', async () => {
    const asUser = await h.app.inject({ method: 'GET', url: '/api/auth/session', headers: h.user });
    expect(asUser.json()).toEqual({ uid: USER_ID, email: 'uche@x.com', admin: false });
    const asAdmin = await h.app.inject({ method: 'GET', url: '/api/auth/session', headers: h.admin });
    expect(asAdmin.json().admin).toBe(true);
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/session' })).statusCode).toBe(401);
  });

  it('claim-admin: 401 / 403 / 200', async () => {
    expect((await post('/api/auth/claim-admin')).statusCode).toBe(401);
    expect((await post('/api/auth/claim-admin', undefined, h.user)).statusCode).toBe(403);
    const ok = await post('/api/auth/claim-admin', undefined, h.admin);
    expect(ok.json()).toEqual({ ok: true, fullName: 'Ada Admin', wasAlreadyAdmin: true });
    expect(ADMIN_ID).toBeTruthy();
  });
});
