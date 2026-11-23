import 'fastify';
import type { Container } from '@/container';

export type SessionUser = { uid: string; email: string; username: string; deviceId: string };

declare module 'fastify' {
  interface FastifyInstance {
    c: Container;
    /** preHandler: 401 unless a valid session is present. Sets `req.session`. */
    authenticate: (req: FastifyRequest) => Promise<void>;
    /** preHandler: 401 without a session, 403 unless profiles.is_admin = true (checked live). */
    requireAdmin: (req: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    session: SessionUser | null;
    admin: { uid: string; email: string } | null;
  }
}
