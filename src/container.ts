// Composition root: every external dependency is created once here and handed to routes via `app.c`.
// Tests pass `overrides` to swap Supabase / Redis / FCM / Paystack for in-memory fakes.
import type { Env } from '@/config/env';
import type { Db } from '@/lib/db/types';
import { createDb } from '@/lib/clients/supabase';
import { createAuthGateway, type AuthGateway } from '@/lib/clients/authGateway';
import { createRedis, type RedisLike } from '@/lib/clients/redis';
import { createMessaging, type MessagingLike } from '@/lib/clients/messaging';
import { createPaystack, type PaystackClient } from '@/lib/clients/paystack';
import { createConfigRepo, type ConfigRepo } from '@/lib/db/config';
import { createAnalytics, type Analytics } from '@/lib/db/analytics';
import { createWalletRepo, type WalletRepo } from '@/lib/db/walletTransactions';
import { createRedisLimiter, createMemoryLimiter, type RedisLimiter, type MemoryLimiter } from '@/lib/rateLimit';
import { createInvestmentSync, type InvestmentSync } from '@/lib/investmentReturns';
import { createEligibility, type Eligibility } from '@/lib/eligibility';

export type Container = {
  env: Env;
  db: Db;
  auth: AuthGateway;
  redis: RedisLike;
  messaging: MessagingLike;
  paystack: PaystackClient;
  config: ConfigRepo;
  analytics: Analytics;
  wallet: WalletRepo;
  rateLimit: RedisLimiter;
  userLimiter: MemoryLimiter;
  syncInvestment: InvestmentSync;
  eligibility: Eligibility;
};

export type Overrides = Partial<Pick<Container, 'db' | 'auth' | 'redis' | 'messaging' | 'paystack'>>;

export function createContainer(env: Env, overrides: Overrides = {}): Container {
  const db = overrides.db ?? createDb(env);
  const redis = overrides.redis ?? createRedis(env);

  return {
    env,
    db,
    redis,
    auth: overrides.auth ?? createAuthGateway(env, db),
    messaging: overrides.messaging ?? createMessaging(env),
    paystack: overrides.paystack ?? createPaystack(env),
    config: createConfigRepo(db),
    analytics: createAnalytics(db),
    wallet: createWalletRepo(db),
    rateLimit: createRedisLimiter(redis),
    userLimiter: createMemoryLimiter({ max: env.RATE_LIMIT_USER_MAX, windowMs: 60_000 }),
    syncInvestment: createInvestmentSync(db, redis),
    eligibility: createEligibility(db)
  };
}
