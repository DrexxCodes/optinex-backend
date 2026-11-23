import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { COOKIE_ACCESS } from '@/config/constants';
import { forbidden, tooManyRequests, unauthenticated } from '@/lib/errors';

function readAccessToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  return req.cookies?.[COOKIE_ACCESS] || null;
}

// Authentication + the admin gate. The browser never sees Supabase — the backend verifies the
// Supabase JWT (cached JWKS, no network on the hot path) from the httpOnly cookie on every request.
export default fp(async (app) => {
  app.decorateRequest('session', null);
  app.decorateRequest('admin', null);
  // store the JWT token in the request object for later use

  async function authenticate(req: FastifyRequest) {
    const token = readAccessToken(req);
    if (!token) throw unauthenticated();

    const claims = await app.c.auth.verify(token);
    if (!claims) throw unauthenticated();

    req.session = { uid: claims.sub, email: claims.email, username: claims.username, deviceId: claims.sessionId };

    // Per-user ceiling on top of the per-IP one (shared NATs, scripted accounts).
    const limit = app.c.userLimiter.hit(claims.sub);
    if (!limit.allowed) throw tooManyRequests(limit.retryAfter);
  }

  app.decorate('authenticate', authenticate);

  // Real authorization for every /api/admin/* route: the JWT proves who the caller is; `is_admin` on
  // their profile (set in the database, never self-assigned) proves they may act as an admin. Checked
  // live so a demotion is immediate.
  app.decorate('requireAdmin', async (req: FastifyRequest) => {
    await authenticate(req);
    const session = req.session!;
    const { data } = await app.c.db.from('profiles').select('is_admin').eq('id', session.uid).maybeSingle();
    if (!data || data.is_admin !== true) throw forbidden();
    req.admin = { uid: session.uid, email: session.email };
  });
});
