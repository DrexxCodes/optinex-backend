// Everything the backend needs from Supabase Auth, behind one small interface (easy to fake in tests).
import type { Env } from '@/config/env';
import { createAuthClient } from './supabase';
import type { Db } from '@/lib/db/types';

export type Tokens = { accessToken: string; refreshToken: string };
export type Claims = { sub: string; email: string; username: string; sessionId: string };

export type SessionResult =
  | { ok: true; userId: string; tokens: Tokens }
  | { ok: false; status: number; message: string };

export type CreateUserResult = { ok: true; id: string } | { ok: false; message: string };

export interface AuthGateway {
  signInWithPassword(email: string, password: string): Promise<SessionResult>;
  refreshSession(refreshToken: string): Promise<SessionResult>;
  /** Verifies an access token (locally against Supabase's JWKS when possible). null = invalid/expired. */
  verify(accessToken: string): Promise<Claims | null>;
  signOut(accessToken: string): Promise<void>;
  createUser(input: { email: string; password: string; username: string; fullName: string }): Promise<CreateUserResult>;
  deleteUser(id: string): Promise<void>;
}

const CLAIMS_CACHE_MAX = 5000;
const CLAIMS_CACHE_TTL_MS = 30_000;

export function createAuthGateway(env: Env, db: Db): AuthGateway {
  // One long-lived client purely for verification so its JWKS cache survives across requests.
  const verifier = createAuthClient(env);
  const claimsCache = new Map<string, { claims: Claims; until: number }>();

  const mapError = (error: { status?: number; message?: string; name?: string }): { ok: false; status: number; message: string } => ({
    ok: false,
    status: error.name === 'AuthRetryableFetchError' ? 503 : (error.status ?? 500),
    message: error.message ?? 'Auth error'
  });

  return {
    async signInWithPassword(email, password) {
      const { data, error } = await createAuthClient(env).auth.signInWithPassword({ email, password });
      if (error || !data.session || !data.user) return mapError(error ?? { status: 401, message: 'Invalid login credentials' });
      return { ok: true, userId: data.user.id, tokens: { accessToken: data.session.access_token, refreshToken: data.session.refresh_token } };
    },

    async refreshSession(refreshToken) {
      const { data, error } = await createAuthClient(env).auth.refreshSession({ refresh_token: refreshToken });
      if (error || !data.session || !data.user) return mapError(error ?? { status: 401, message: 'Session expired' });
      return { ok: true, userId: data.user.id, tokens: { accessToken: data.session.access_token, refreshToken: data.session.refresh_token } };
    },

    async verify(accessToken) {
      const now = Date.now();
      const cached = claimsCache.get(accessToken);
      if (cached && cached.until > now) return cached.claims;

      const { data, error } = await verifier.auth.getClaims(accessToken);
      const c = data?.claims;
      if (error || !c?.sub) return null;

      const claims: Claims = {
        sub: c.sub,
        email: String(c.email ?? ''),
        username: ((c.user_metadata ?? {}) as { username?: string }).username ?? '',
        sessionId: String(c.session_id ?? '')
      };

      // Cache for a short, bounded time (never past the token's own expiry).
      const expMs = typeof c.exp === 'number' ? c.exp * 1000 : now + CLAIMS_CACHE_TTL_MS;
      if (claimsCache.size >= CLAIMS_CACHE_MAX) claimsCache.delete(claimsCache.keys().next().value as string);
      claimsCache.set(accessToken, { claims, until: Math.min(expMs, now + CLAIMS_CACHE_TTL_MS) });
      return claims;
    },

    async signOut(accessToken) {
      // 'local' ends only this device's session.
      claimsCache.delete(accessToken);
      await db.auth.admin.signOut(accessToken, 'local').catch(() => {});
    },

    async createUser({ email, password, username, fullName }) {
      const created = await db.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { username, full_name: fullName }
      });
      if (created.error || !created.data.user) return { ok: false, message: created.error?.message ?? 'Could not create user' };
      return { ok: true, id: created.data.user.id };
    },

    async deleteUser(id) {
      await db.auth.admin.deleteUser(id).catch(() => {});
    }
  };
}
