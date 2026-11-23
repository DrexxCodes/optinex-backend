import fp from 'fastify-plugin';
import { HttpError } from '@/lib/errors';

// Every error leaves as `{ error: string, ...extra }` — the shape both frontends already read.
export default fp(async (app) => {
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found.' }));

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).headers(err.headers).send({ error: err.message, ...err.extra });
    }

    const status: number = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      // Fastify's own client errors (bad JSON, payload too large) and rate-limit rejections.
      const message = typeof err?.error === 'string' ? err.error : status === 413 ? 'Request body too large.' : 'Invalid request.';
      return reply.code(status).send({ error: message });
    }

    req.log.error(err);
    return reply.code(500).send({ error: 'Internal server error.' });
  });
});
