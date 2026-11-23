import { createHash } from 'node:crypto';
import type { Container } from '@/container';
import type { Tokens } from '@/lib/clients/authGateway';
import { HttpError, tooManyRequests } from '@/lib/errors';
import { isUniqueViolation } from '@/lib/db/format';
import { REFERRAL_BONUS } from '@/config/constants';
import {
  REFERRAL_LEADERBOARD_KEY,
  REFERRAL_LEADERBOARD_NAMES_KEY,
  REFERRAL_WEEKLY_LEADERBOARD_KEY
} from '@/config/redisKeys';

export type SignUpInput = { fullName?: string; email?: string; username?: string; password?: string; referralKey?: string };

export function createAuthService(c: Container) {
  const { db, auth, redis } = c;

  async function loadProfile(uid: string) {
    const { data } = await db.from('profiles').select('*').eq('id', uid).maybeSingle();
    return data;
  }

  const publicUser = (p: any) => ({ uid: p.id, fullName: p.full_name, email: p.email, username: p.username });

  return {
    /**
     * Credentials are checked by Supabase Auth (server-side now), then the post-login work runs:
     * analytics + investment catch-up. Returns the tokens for the caller to turn into cookies.
     */
    async signIn(emailRaw: string, password: string): Promise<{ tokens: Tokens; user: ReturnType<typeof publicUser> }> {
      const email = emailRaw.trim().toLowerCase();

      // Credential-stuffing guard: attempts per email across all IPs (Redis, survives restarts).
      const hash = createHash('sha256').update(email).digest('hex').slice(0, 32);
      const limit = await c.rateLimit('signin-email', hash, c.env.RATE_LIMIT_SIGNIN_EMAIL_MAX, 15 * 60);
      if (!limit.allowed) throw tooManyRequests(limit.retryAfter, 'Too many attempts. Please wait a moment and try again.');

      const result = await auth.signInWithPassword(email, password);
      if (!result.ok) {
        if (result.status === 429) throw new HttpError(429, 'Too many attempts. Please wait a moment and try again.');
        if (result.status >= 500) throw new HttpError(500, 'Something went wrong signing you in.');
        throw new HttpError(401, 'Invalid email or password.');
      }

      const profile = await loadProfile(result.userId);
      if (!profile) {
        await auth.signOut(result.tokens.accessToken);
        throw new HttpError(401, 'Invalid email or password.');
      }

      await c.analytics.safeLog('signin', 0, 'signin');

      // Catch this user up on daily investment returns (and expire their package if it ran out) right
      // as they log in. The profile row is passed in to avoid a second read.
      try {
        await c.syncInvestment(result.userId, profile);
      } catch (err) {
        console.error('[signin] investment returns sync failed:', err);
      }

      return { tokens: result.tokens, user: publicUser(profile) };
    },

    /** Creates the account (auth user + atomic profile + referral bonus) and then signs the user in. */
    async signUp(input: SignUpInput) {
      const { fullName, email, username, password, referralKey } = input;

      if (!fullName || !email || !username || !password) {
        throw new HttpError(400, 'Full name, email, username, and password are required.');
      }
      if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
      if (password.length > 128 || String(email).length > 254 || String(username).length > 50 || fullName.length > 100) {
        throw new HttpError(400, 'One of the fields you entered is too long.');
      }

      const normalizedEmail = String(email).trim().toLowerCase();
      const normalizedUsername = String(username).trim().toLowerCase();

      const [emailHit, usernameHit] = await Promise.all([
        db.from('profiles').select('id').eq('email', normalizedEmail).limit(1),
        db.from('profiles').select('id').eq('username', normalizedUsername).limit(1)
      ]);
      if (emailHit.data?.length) throw new HttpError(409, 'An account with this email already exists.');
      if (usernameHit.data?.length) throw new HttpError(409, 'That username is already taken.');

      // 1) Auth account (email pre-confirmed — there's no email-verification step in this product).
      const created = await auth.createUser({ email: normalizedEmail, password, username: normalizedUsername, fullName });
      if (!created.ok) {
        if (/already|registered|exists/i.test(created.message)) throw new HttpError(409, 'An account with this email already exists.');
        console.error('[signup] createUser', created.message);
        throw new HttpError(500, 'Something went wrong creating your account.');
      }
      const authUserId = created.id;

      // 2) Profile + referral bonus, atomically, in one Postgres function.
      const { data: result, error: profileError } = await db.rpc('create_profile', {
        p_id: authUserId,
        p_full_name: fullName,
        p_email: normalizedEmail,
        p_username: normalizedUsername,
        p_referral_key: referralKey ? String(referralKey) : null,
        p_bonus: REFERRAL_BONUS
      });

      if (profileError) {
        // Roll the auth account back so the email isn't left orphaned.
        await auth.deleteUser(authUserId);
        if (isUniqueViolation(profileError, 'profiles_username_key')) throw new HttpError(409, 'That username is already taken.');
        if (isUniqueViolation(profileError, 'profiles_email_key')) throw new HttpError(409, 'An account with this email already exists.');
        console.error('[signup] create_profile', profileError);
        throw new HttpError(500, 'Something went wrong creating your account.');
      }

      const referrerId: string | null = result?.referrer_id ?? null;
      if (referrerId) {
        await c.analytics.safeLog('referral_bonus', REFERRAL_BONUS, 'signup');

        // Cache-only leaderboard bump — a Redis hiccup must never fail the signup itself.
        try {
          await redis.zincrby(REFERRAL_LEADERBOARD_KEY, 1, referrerId);
          await redis.zincrby(REFERRAL_WEEKLY_LEADERBOARD_KEY, 1, referrerId);
          await redis.hset(REFERRAL_LEADERBOARD_NAMES_KEY, {
            [referrerId]: JSON.stringify({
              fullName: result?.referrer_full_name ?? 'Incossify user',
              username: result?.referrer_username ?? ''
            })
          });
        } catch (err) {
          console.error('[signup] referral leaderboard update failed:', err);
        }
      }

      await c.analytics.safeLog('signup', 0, 'signup');

      // 3) Establish the session in the same round trip. If this hiccups the account still exists —
      // the client just sends the user to the sign-in page.
      const session = await auth.signInWithPassword(normalizedEmail, password);
      return {
        user: { uid: authUserId, fullName, email: normalizedEmail, username: normalizedUsername },
        tokens: session.ok ? session.tokens : null
      };
    },

    /** Rotates the tokens. A refresh is as good a "login" moment as sign-in for catching up on returns. */
    async refresh(refreshToken: string): Promise<{ tokens: Tokens } | { invalid: true } | { unavailable: true }> {
      const result = await auth.refreshSession(refreshToken);
      if (!result.ok) return result.status >= 500 ? { unavailable: true } : { invalid: true };

      try {
        const profile = await loadProfile(result.userId);
        if (profile) await c.syncInvestment(result.userId, profile);
      } catch (err) {
        console.error('[refresh] investment returns sync failed:', err);
      }
      return { tokens: result.tokens };
    },

    async session(uid: string) {
      const { data } = await db.from('profiles').select('is_admin').eq('id', uid).maybeSingle();
      return { admin: data?.is_admin === true };
    },

    async claimAdmin(uid: string) {
      const { data } = await db.from('profiles').select('full_name, is_admin').eq('id', uid).maybeSingle();
      if (!data) throw new HttpError(404, 'User not found.');
      if (data.is_admin !== true) throw new HttpError(403, 'This account does not have admin access.');
      return { ok: true, fullName: data.full_name ?? '', wasAlreadyAdmin: true };
    }
  };
}
