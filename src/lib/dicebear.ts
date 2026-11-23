// Avatar generation — Dicebear `micah`, seeded with the user's email (same account → same avatar).
import { createAvatar } from '@dicebear/core';
import { micah } from '@dicebear/collection';

const normalize = (seed: string) => seed.trim().toLowerCase();

// Generation is CPU-bound and the output is a pure function of the seed, so keep a small LRU in memory.
const CACHE_MAX = 500;
const cache = new Map<string, string>();

export function generateAvatarSvg(seedEmail: string): string {
  const seed = normalize(seedEmail);
  const hit = cache.get(seed);
  if (hit !== undefined) {
    cache.delete(seed);
    cache.set(seed, hit);
    return hit;
  }
  const svg = createAvatar(micah, { seed, backgroundColor: ['1C54F5', 'EAF1FF', '4FD1F5'] }).toString();
  cache.set(seed, svg);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return svg;
}

// Path (not a remote URL) the client renders in an <Image>/<img> src — served by this backend via the app's /api proxy.
export function avatarPath(seedEmail: string): string {
  return `/api/avatar/${encodeURIComponent(normalize(seedEmail))}`;
}
