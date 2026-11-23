import type { FastifyInstance } from 'fastify';
import { loadEnv, type Env } from '@/config/env';
import { buildApp } from '@/app';
import { FakeDb } from './fakeDb';
import { FakeRedis } from './fakeRedis';
import { FakeAuth } from './fakeAuth';

export const ADMIN_ID = '22222222-2222-4222-8222-000000000001';
export const USER_ID = '22222222-2222-4222-8222-000000000002';
export const OTHER_ID = '22222222-2222-4222-8222-000000000003';

export function testEnv(extra: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'pub',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'tok',
    CRON_SECRET: 'cron-secret',
    RATE_LIMIT_GLOBAL_MAX: '1000',
    ...extra
  });
}

export type Harness = Awaited<ReturnType<typeof makeHarness>>;

export async function makeHarness(extraEnv: Record<string, string> = {}) {
  const db = new FakeDb();
  const redis = new FakeRedis();
  const auth = new FakeAuth();
  const sent: any[] = [];
  const subscribed: string[] = [];
  const messaging = {
    send: async (m: any) => { sent.push(m); return 'msg-1'; },
    subscribeToTopic: async (_token: string, topic: string) => { subscribed.push(topic); },
    unsubscribeFromTopic: async () => {}
  };
  const paystack = {
    banks: [{ code: '058', name: 'GTBank' }, { code: '044', name: 'Access' }],
    fetchBanks: async function () { return this.banks; },
    resolveAccount: async (n: string) => (n === '0000000000'
      ? ({ ok: false, status: 422, error: 'Could not resolve account name.' } as const)
      : ({ ok: true, accountName: 'ADA EZE' } as const))
  };

  // Standard cast: a regular user, an admin, and a second user.
  db.seed('profiles', [
    { id: ADMIN_ID, full_name: 'Ada Admin', email: 'admin@x.com', username: 'ada', is_admin: true, wallet_amount: 0 },
    { id: USER_ID, full_name: 'Uche User', email: 'uche@x.com', username: 'uche', is_admin: false, wallet_amount: 5000, package_status: 'Free', account_tier: 'standard' },
    { id: OTHER_ID, full_name: 'Obi Other', email: 'obi@x.com', username: 'obi', is_admin: false, wallet_amount: 0 }
  ]);
  auth.addUser({ id: ADMIN_ID, email: 'admin@x.com', password: 'secret1', username: 'ada' });
  auth.addUser({ id: USER_ID, email: 'uche@x.com', password: 'secret1', username: 'uche' });
  auth.addUser({ id: OTHER_ID, email: 'obi@x.com', password: 'secret1', username: 'obi' });

  // Mirrors the deployed `merge_config` Postgres function: shallow-merge into config.value, creating the row if needed.
  db.onRpc('merge_config', ({ p_key, p_value }: any) => {
    const row = db.rows('config').find((r) => r.key === p_key);
    if (row) row.value = { ...(row.value ?? {}), ...p_value };
    else db.rows('config').push({ key: p_key, value: { ...p_value } });
    return null;
  });

  const app: FastifyInstance = await buildApp(testEnv(extraEnv), { db: db as any, redis, auth, messaging: messaging as any, paystack: paystack as any });
  const as = (uid: string) => ({ cookie: auth.cookieFor(uid) });

  return { app, db, redis, auth, sent, subscribed, paystack, user: as(USER_ID), admin: as(ADMIN_ID), as };
}
