// Paystack helpers — the secret key never leaves this server.
import type { Env } from '@/config/env';

const BASE = 'https://api.paystack.co';
const TIMEOUT_MS = 8_000;
const BANKS_TTL_MS = 24 * 60 * 60 * 1000;

export type Bank = { code: string; name: string };
export type ResolveResult = { ok: true; accountName: string } | { ok: false; status: number; error: string };

export interface PaystackClient {
  fetchBanks(): Promise<Bank[] | null>;
  resolveAccount(accountNumber: string, bankCode: string): Promise<ResolveResult>;
}

export function createPaystack(env: Pick<Env, 'PAYSTACK_SECRET_KEY'>): PaystackClient {
  const headers = () => ({ Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` });
  let banksCache: { banks: Bank[]; until: number } | null = null;

  return {
    // Same list (and same de-duplication by code) the old /api/withdrawal/banks returned. The 24h cache
    // replaces Next's `revalidate` so the bank dropdown costs one Paystack call a day.
    async fetchBanks() {
      if (banksCache && banksCache.until > Date.now()) return banksCache.banks;
      try {
        const res = await fetch(`${BASE}/bank?country=nigeria&type=nuban`, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return null;
        const data: any = await res.json();
        const seen = new Set<string>();
        const banks: Bank[] = [];
        for (const b of data.data ?? []) {
          if (!b.code || seen.has(b.code)) continue;
          seen.add(b.code);
          banks.push({ code: b.code, name: b.name });
        }
        banksCache = { banks, until: Date.now() + BANKS_TTL_MS };
        return banks;
      } catch {
        return null;
      }
    },

    async resolveAccount(accountNumber, bankCode) {
      const url = `${BASE}/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`;
      let res: Response;
      try {
        res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
      } catch {
        return { ok: false, status: 502, error: 'Could not reach Paystack. Try again.' };
      }

      let data: any = null;
      try {
        data = await res.json();
      } catch {
        /* non-JSON body — handled below */
      }

      if (!res.ok || !data?.data?.account_name) {
        return { ok: false, status: 422, error: data?.message || 'Could not resolve that account. Double-check the details.' };
      }
      return { ok: true, accountName: data.data.account_name };
    }
  };
}
