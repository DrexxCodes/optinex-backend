import type { RedisLike } from '@/lib/clients/redis';

export class FakeRedis implements RedisLike {
  kv = new Map<string, any>();
  z = new Map<string, Map<string, number>>();
  h = new Map<string, Record<string, string>>();
  failing = false;

  private guard() { if (this.failing) throw new Error('redis down'); }

  async incr(k: string) { this.guard(); const n = (this.kv.get(k) ?? 0) + 1; this.kv.set(k, n); return n; }
  async expire() { this.guard(); return 1; }
  async get<T>(k: string) { this.guard(); return (this.kv.get(k) ?? null) as T | null; }
  async set(k: string, v: unknown) { this.guard(); this.kv.set(k, v); return 'OK'; }
  async del(...keys: string[]) { this.guard(); keys.forEach((k) => { this.kv.delete(k); this.z.delete(k); this.h.delete(k); }); return keys.length; }
  async zadd(k: string, e: { score: number; member: string }) { this.guard(); (this.z.get(k) ?? this.z.set(k, new Map()).get(k)!).set(e.member, e.score); return 1; }
  async zincrby(k: string, inc: number, m: string) { this.guard(); const s = this.z.get(k) ?? this.z.set(k, new Map()).get(k)!; s.set(m, (s.get(m) ?? 0) + inc); return s.get(m)!; }
  async zscore(k: string, m: string) { this.guard(); return this.z.get(k)?.get(m) ?? null; }
  private sorted(k: string, rev?: boolean) {
    const e = [...(this.z.get(k) ?? new Map()).entries()].sort((a, b) => a[1] - b[1]);
    return rev ? e.reverse() : e;
  }
  async zrevrank(k: string, m: string) { this.guard(); const i = this.sorted(k, true).findIndex(([mem]) => mem === m); return i < 0 ? null : i; }
  async zrange(k: string, a: number, b: number, o?: { rev?: boolean; withScores?: boolean }) {
    this.guard();
    const all = this.sorted(k, o?.rev);
    const slice = all.slice(a, b === -1 ? undefined : b + 1);
    return o?.withScores ? slice.flatMap(([m, s]) => [m, s]) : slice.map(([m]) => m);
  }
  async hset(k: string, v: Record<string, unknown>) { this.guard(); const cur = this.h.get(k) ?? {}; for (const [f, x] of Object.entries(v)) cur[f] = String(x); this.h.set(k, cur); return 1; }
  async hmget(k: string, ...f: string[]) { this.guard(); const cur = this.h.get(k) ?? {}; const out: Record<string, string> = {}; f.forEach((x) => { if (cur[x] !== undefined) out[x] = cur[x]; }); return Object.keys(out).length ? out : null; }
}
