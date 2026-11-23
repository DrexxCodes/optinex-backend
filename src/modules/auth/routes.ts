import type { FastifyPluginAsync } from 'fastify';
import { COOKIE_ACCESS, COOKIE_REFRESH } from '@/config/constants';
import { HttpError } from '@/lib/errors';
import { bodyOf } from '../helpers';
import { clearSessionCookies, setSessionCookies } from './cookies';
import { createAuthService } from './service';

// Shared by both apps: /api/auth/{signin,signup,refresh,logout,session,claim-admin}
const authRoutes: FastifyPluginAsync = async (app) => {
  const { env } = app.c;
  const svc = createAuthService(app.c);

  // Brute-force / spam protection layered on the global limiter: tight per-IP caps, and a temporary
  // ban for clients that keep hammering after being limited.
  const ban = env.RATE_LIMIT_BAN_AFTER > 0 ? env.RATE_LIMIT_BAN_AFTER : undefined;

  app.post(
    '/signin',
    { config: { rateLimit: { max: env.RATE_LIMIT_SIGNIN_MAX, timeWindow: '1 minute', ban } } },
    async (req, reply) => {
      const { email, password } = bodyOf(req);
      if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
        throw new HttpError(400, 'Email and password are required.');
      }
      const { tokens, user } = await svc.signIn(email, password);
      setSessionCookies(reply, env, tokens);
      return { user };
    }
  );

  app.post(
    '/signup',
    { config: { rateLimit: { max: env.RATE_LIMIT_SIGNUP_MAX, timeWindow: '1 hour', ban } } },
    async (req, reply) => {
      const b = bodyOf(req);
      const { user, tokens } = await svc.signUp({
        fullName: typeof b.fullName === 'string' ? b.fullName : undefined,
        email: typeof b.email === 'string' ? b.email : undefined,
        username: typeof b.username === 'string' ? b.username : undefined,
        password: typeof b.password === 'string' ? b.password : undefined,
        referralKey: typeof b.referralKey === 'string' ? b.referralKey : undefined
      });
      if (tokens) setSessionCookies(reply, env, tokens);
      return { user, signedIn: !!tokens };
    }
  );

  app.post(
    '/refresh',
    { config: { rateLimit: { max: env.RATE_LIMIT_REFRESH_MAX, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const refreshToken = req.cookies[COOKIE_REFRESH];
      if (!refreshToken) throw new HttpError(401, 'Session expired.');

      const result = await svc.refresh(refreshToken);
      if ('unavailable' in result) throw new HttpError(503, 'Could not refresh your session right now.');
      if ('invalid' in result) {
        clearSessionCookies(reply, env);
        throw new HttpError(401, 'Session expired.');
      }
      setSessionCookies(reply, env, result.tokens);
      return { ok: true };
    }
  );

  app.post('/logout', async (req, reply) => {
    const accessToken = req.cookies[COOKIE_ACCESS];
    if (accessToken) await app.c.auth.signOut(accessToken);
    clearSessionCookies(reply, env);
    return { ok: true };
  });

  // Used by the admin app's server components (layout/root page) instead of a direct DB read.
  app.get('/session', { preHandler: app.authenticate }, async (req) => {
    const s = req.session!;
    const { admin } = await svc.session(s.uid);
    return { uid: s.uid, email: s.email, admin };
  });

  // Confirms admin access for /welcome. Accounts are never promoted here — only `profiles.is_admin`
  // set in the database (or by an existing admin) counts.
  app.post('/claim-admin', { preHandler: app.authenticate }, async (req) => svc.claimAdmin(req.session!.uid));
};

export default authRoutes;
