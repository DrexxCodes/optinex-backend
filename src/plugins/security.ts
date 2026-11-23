import fp from 'fastify-plugin';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

// Cookies, security headers, optional CORS and the global per-IP rate limiter (bots / spam).
export default fp(async (app) => {
  const { env } = app.c;

  await app.register(cookie);
  await app.register(helmet, { crossOriginResourcePolicy: { policy: 'cross-origin' } });

  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  // Same-origin (Next.js rewrite) needs no CORS; only enable it when origins are listed explicitly.
  if (origins.length) await app.register(cors, { origin: origins, credentials: true });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    allowList: (req) => req.url === '/health',
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: ctx.statusCode,
      error: ctx.ban ? 'Too many failed attempts. Please try again later.' : 'Too many requests. Please slow down and try again shortly.'
    })
  });
});
