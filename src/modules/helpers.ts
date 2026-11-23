import type { FastifyRequest } from 'fastify';

/** Request JSON body as a loose object (missing/non-object bodies become `{}`). */
export function bodyOf(req: FastifyRequest): Record<string, any> {
  const b = req.body;
  return b && typeof b === 'object' ? (b as Record<string, any>) : {};
}

export const queryOf = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string | undefined>;
export const paramsOf = (req: FastifyRequest) => (req.params ?? {}) as Record<string, string>;
