import type { FastifyReply } from 'fastify';
import type { Env } from '@/config/env';
import { COOKIE_ACCESS, COOKIE_MAX_AGE_SECONDS, COOKIE_REFRESH } from '@/config/constants';
import type { Tokens } from '@/lib/clients/authGateway';

// httpOnly session cookies, set by the backend and passed straight through the Next.js /api rewrite,
// so they end up host-only on whichever app (user / admin) the browser is talking to.
const options = (env: Env) => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: COOKIE_MAX_AGE_SECONDS,
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {})
});

export function setSessionCookies(reply: FastifyReply, env: Env, tokens: Tokens) {
  reply.setCookie(COOKIE_ACCESS, tokens.accessToken, options(env));
  reply.setCookie(COOKIE_REFRESH, tokens.refreshToken, options(env));
}

export function clearSessionCookies(reply: FastifyReply, env: Env) {
  const { maxAge: _maxAge, ...rest } = options(env);
  reply.clearCookie(COOKIE_ACCESS, rest);
  reply.clearCookie(COOKIE_REFRESH, rest);
}
