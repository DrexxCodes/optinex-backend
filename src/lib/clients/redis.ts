import { Redis } from '@upstash/redis';
import type { Env } from '@/config/env';

// The subset of Redis the backend uses — keeps services easy to fake in tests.
export interface RedisLike {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  zrange(key: string, start: number, stop: number, opts?: { rev?: boolean; withScores?: boolean }): Promise<(string | number)[]>;
  zscore(key: string, member: string): Promise<number | null>;
  zadd(key: string, entry: { score: number; member: string }): Promise<unknown>;
  zincrby(key: string, increment: number, member: string): Promise<unknown>;
  zrevrank(key: string, member: string): Promise<number | null>;
  hmget(key: string, ...fields: string[]): Promise<Record<string, string> | null>;
  hset(key: string, values: Record<string, unknown>): Promise<unknown>;
}

// Upstash's REST client: no TCP connection to manage, so it is cheap on a small server.
export function createRedis(env: Pick<Env, 'UPSTASH_REDIS_REST_URL' | 'UPSTASH_REDIS_REST_TOKEN'>): RedisLike {
  const r = new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
  return {
    incr: (k) => r.incr(k),
    expire: (k, s) => r.expire(k, s),
    get: <T>(k: string) => r.get<T>(k),
    set: (k, v, o) => (o?.ex ? r.set(k, v as any, { ex: o.ex }) : r.set(k, v as any)),
    del: (...keys) => r.del(...keys),
    zrange: (k, a, b, o) => r.zrange(k, a, b, o as any) as Promise<(string | number)[]>,
    zscore: (k, m) => r.zscore(k, m),
    zadd: (k, e) => r.zadd(k, e),
    zincrby: (k, i, m) => r.zincrby(k, i, m),
    zrevrank: (k, m) => r.zrevrank(k, m),
    hmget: (k, ...f) => r.hmget<Record<string, string>>(k, ...f),
    hset: (k, v) => r.hset(k, v)
  };
}
