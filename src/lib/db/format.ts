// Helpers for turning Postgres rows into the exact JSON shapes the UIs already expect.
export type { Row } from './types';

/** timestamptz string -> normalized ISO string (ms precision), or null. */
export function iso(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const num = (v: unknown, fallback = 0): number => (v === null || v === undefined ? fallback : Number(v));

/** Message raised by a Postgres function (`raise exception 'CODE'`) or ''. */
export function rpcMessage(error: { message?: string } | null | undefined): string {
  return error?.message ?? '';
}

/** Postgres unique-violation helper — true when the error is for the named constraint. */
export function isUniqueViolation(error: { code?: string; message?: string } | null | undefined, constraint?: string): boolean {
  if (error?.code !== '23505') return false;
  return constraint ? (error.message ?? '').includes(constraint) : true;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Upstash's zrange with withScores returns a flat array: [member, score, member, score, ...] */
export function parseFlatScored(flat: (string | number)[]): { member: string; score: number }[] {
  const out: { member: string; score: number }[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ member: String(flat[i]), score: Number(flat[i + 1]) });
  return out;
}
