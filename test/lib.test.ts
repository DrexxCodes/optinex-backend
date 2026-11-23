import { describe, expect, it } from 'vitest';
import { loadEnv } from '@/config/env';
import { pickWeightedPrize, PRIZES } from '@/config/prizes';
import { buildLoanTimeline, nextLoanStage } from '@/config/loans';
import { normalizeNigerianPhone } from '@/lib/loanValidation';
import { createInvestmentSync } from '@/lib/investmentReturns';
import { createEligibility } from '@/lib/eligibility';
import { generateReference } from '@/lib/refGenerator';
import { createMemoryLimiter } from '@/lib/rateLimit';
import { FakeDb } from './helpers/fakeDb';
import { FakeRedis } from './helpers/fakeRedis';

const DAY = 24 * 3600 * 1000;

describe('env', () => {
  const base = { SUPABASE_URL: 'https://a.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'p', SUPABASE_SERVICE_ROLE_KEY: 's', UPSTASH_REDIS_REST_URL: 'https://u.io', UPSTASH_REDIS_REST_TOKEN: 't' };

  it('accepts the legacy NEXT_PUBLIC_* names so the old .env copies over', () => {
    const env = loadEnv({ NEXT_PUBLIC_SUPABASE_URL: 'https://a.supabase.co', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pk', SUPABASE_SERVICE_ROLE_KEY: 's', UPSTASH_REDIS_REST_URL: 'https://u.io', UPSTASH_REDIS_REST_TOKEN: 't' });
    expect(env.SUPABASE_URL).toBe('https://a.supabase.co');
    expect(env.SUPABASE_PUBLISHABLE_KEY).toBe('pk');
  });
  it('treats blank values as unset and applies defaults', () => {
    const env = loadEnv({ ...base, CRON_SECRET: '', PORT: '' });
    expect(env.CRON_SECRET).toBeUndefined();
    expect(env.PORT).toBe(4000);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(loadEnv({ ...base, NODE_ENV: 'production' }).COOKIE_SECURE).toBe(true);
  });
  it('fails loudly and names every missing variable', () => {
    expect(() => loadEnv({})).toThrow(/SUPABASE_URL[\s\S]*SUPABASE_SERVICE_ROLE_KEY[\s\S]*UPSTASH_REDIS_REST_URL/);
  });
});

describe('prizes', () => {
  it('weighted pick honours the weights at the boundaries', () => {
    expect(pickWeightedPrize(() => 0).id).toBe('no_win');
    expect(pickWeightedPrize(() => 0.999999).id).toBe('10000');
    expect(PRIZES.reduce((s, p) => s + p.weight, 0)).toBe(100);
  });
});

describe('loans config', () => {
  it('walks pending -> processing -> approved -> disbursed -> end', () => {
    expect(nextLoanStage('pending')).toBe('processing');
    expect(nextLoanStage('disbursed')).toBeNull();
  });
  it('timeline always has all four steps', () => {
    expect(buildLoanTimeline([])).toHaveLength(4);
  });
  it('normalizes Nigerian phone formats', () => {
    expect(normalizeNigerianPhone('+234 803 123 4567')).toBe('08031234567');
    expect(normalizeNigerianPhone('2348031234567')).toBe('08031234567');
    expect(normalizeNigerianPhone('12345')).toBeNull();
  });
});

describe('investment returns sync', () => {
  const setup = (profile: Record<string, any>, price = 10000) => {
    const db = new FakeDb();
    const redis = new FakeRedis();
    db.seed('profiles', [{ id: 'u', ...profile }]);
    db.seed('packages', [{ id: 'p', price }]);
    db.onRpc('credit_investment_returns', (a) => a.p_days * a.p_daily);
    db.onRpc('expire_package', () => null);
    return { db, redis, sync: createInvestmentSync(db as any, redis) };
  };

  it('no-ops for Free users', async () => {
    expect(await setup({ package_status: 'Free' }).sync('u')).toEqual({ status: 'no-package' });
  });

  it('credits one transaction per missed day at 10% of the price', async () => {
    const { sync, db, redis } = setup({ package_id: 'p', package_status: 'Active', package_started_at: Date.now() - 3 * DAY - 5000, package_expires_at: Date.now() + 20 * DAY });
    const r = await sync('u');
    expect(r).toEqual({ status: 'credited', days: 3, totalCredited: 3000 });
    expect(db.rpcCalls[0].args).toMatchObject({ p_user: 'u', p_days: 3, p_daily: 1000 });
    expect(redis.kv.get('investment:lastReturn:u')).toBeGreaterThan(Date.now() - DAY); // cursor advanced
    expect(await sync('u')).toEqual({ status: 'up-to-date' }); // idempotent within the day
  });

  it('caps the backlog at 10 days', async () => {
    const { sync } = setup({ package_id: 'p', package_status: 'Active', package_started_at: Date.now() - 40 * DAY, package_expires_at: Date.now() + 5 * DAY });
    expect(await sync('u')).toMatchObject({ status: 'credited', days: 10 });
  });

  it('pays up to expiry then flips the user back to Free', async () => {
    const { sync, db } = setup({ package_id: 'p', package_status: 'Active', package_started_at: Date.now() - 5 * DAY, package_expires_at: Date.now() - 1000 });
    const r = await sync('u');
    expect(r.status).toBe('expired');
    expect(db.rpcCalls.map((c) => c.name)).toEqual(['credit_investment_returns', 'expire_package']);
  });

  it('survives a Redis outage by falling back to the profile cursor', async () => {
    const { sync, redis } = setup({ package_id: 'p', package_status: 'Active', package_started_at: Date.now() - 2 * DAY - 5000, package_expires_at: Date.now() + 9 * DAY });
    redis.failing = true;
    expect(await sync('u')).toMatchObject({ status: 'credited', days: 2 });
  });
});

describe('loan eligibility', () => {
  it('produces actionable messages', async () => {
    const db = new FakeDb();
    let count = 0;
    db.onRpc('distinct_active_package_count', () => count);
    const el = createEligibility(db as any);
    expect((await el.getLoanBlock('u', 'standard'))?.code).toBe('UPGRADE_REQUIRED');
    expect((await el.getLoanBlock('u', 'upgraded'))?.code).toBe('PACKAGE_REQUIRED');
    count = 1;
    expect((await el.getLoanBlock('u', 'upgraded'))?.message).toBe('You have 1 active package. Add one more package to apply for a loan.');
    count = 2;
    expect(await el.getLoanBlock('u', 'upgraded')).toBeNull();
  });
});

describe('misc', () => {
  it('references are 14-digit stamp + 10 random digits', () => {
    expect(generateReference()).toMatch(/^\d{24}$/);
  });
  it('memory limiter blocks after max and reports retry-after', () => {
    const l = createMemoryLimiter({ max: 2, windowMs: 60_000 });
    expect([l.hit('k').allowed, l.hit('k').allowed, l.hit('k').allowed]).toEqual([true, true, false]);
    expect(l.hit('k').retryAfter).toBeGreaterThan(0);
    expect(l.hit('other').allowed).toBe(true);
    l.stop();
  });
});
