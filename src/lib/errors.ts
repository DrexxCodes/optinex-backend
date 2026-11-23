// Throw these from handlers/services; the global error handler turns them into `{ error, ...extra }`.
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly extra: Record<string, unknown> = {},
    public readonly headers: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthenticated = () => new HttpError(401, 'Unauthenticated.');
export const forbidden = () => new HttpError(403, 'Forbidden.');
export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string, extra?: Record<string, unknown>) => new HttpError(409, message, extra);
export const tooManyRequests = (retryAfter: number, message = 'Too many requests. Please slow down and try again shortly.') =>
  new HttpError(429, message, {}, { 'Retry-After': String(Math.max(1, retryAfter)) });
