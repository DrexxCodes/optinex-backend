// Product constants that used to be scattered across route files.
export const COOKIE_ACCESS = 'optinex_at';
export const COOKIE_REFRESH = 'optinex_rt';
export const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;

export const REFERRAL_BONUS = 2000;
export const CHECKIN_REWARD = 1000;
export const MIN_DISTINCT_PACKAGES = 2;
export const PLATFORM_TOPIC = 'platform_all';

// Casino hosts 4 games, each with its own leaderboard.
export const CASINO_GAME_IDS = ['brick-slasher', 'reaction-tap', 'stack-tower', 'endless-runner'] as const;
export type CasinoGameId = (typeof CASINO_GAME_IDS)[number];
export const isCasinoGame = (v: unknown): v is CasinoGameId => (CASINO_GAME_IDS as readonly unknown[]).includes(v);

// ₦ per referral on the admin leaderboard (display only; real bonus is REFERRAL_BONUS at signup).
export const REFERRAL_INCOME_RATE = 1000;
