import { createClient } from '@supabase/supabase-js';
import type { Env } from '@/config/env';
import type { Db } from '@/lib/db/types';

const REQUEST_TIMEOUT_MS = 15_000;

// Never let a stalled upstream hold a request open forever.
const timeoutFetch: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
};

const baseOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: timeoutFetch }
};

/** Service-role client. Bypasses RLS on purpose: this backend is the only door into the data. */
export function createDb(env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>): Db {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, baseOptions);
}

/** Stateless publishable-key client for Supabase Auth calls (sign-in / refresh / token verification). */
export function createAuthClient(env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_PUBLISHABLE_KEY'>) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, baseOptions);
}
