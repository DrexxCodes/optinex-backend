import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from '@/config/env';
import { createContainer, type Overrides } from '@/container';
import securityPlugin from '@/plugins/security';
import authPlugin from '@/plugins/auth';
import errorsPlugin from '@/plugins/errors';
import routes from '@/routes';

function parseTrustProxy(v: string): boolean | number | string {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return /^\d+$/.test(v) ? Number(v) : v; // hop count or CIDR list
}

export async function buildApp(env: Env, overrides: Overrides = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: parseTrustProxy(env.TRUST_PROXY) as any,
    bodyLimit: env.BODY_LIMIT_BYTES,
    routerOptions: { maxParamLength: 300 }, // avatar seeds are emails (RFC max 254, longer once URL-encoded)
    requestTimeout: 30_000,
    connectionTimeout: 30_000
  });

  const container = createContainer(env, overrides);
  app.decorate('c', container);
  app.addHook('onClose', async () => container.userLimiter.stop());

  await app.register(errorsPlugin);
  await app.register(securityPlugin);
  await app.register(authPlugin);

  app.get('/health', async () => ({ ok: true }));
  await app.register(routes);

  return app;
}
