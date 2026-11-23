import type { CasinoGameId } from './constants';

export const gameLeaderboardKey = (gameId: CasinoGameId) => `casino:leaderboard:${gameId}`;
export const gameLeaderboardNamesKey = (gameId: CasinoGameId) => `casino:usernames:${gameId}`;

export const REFERRAL_LEADERBOARD_KEY = 'referral:leaderboard';
export const REFERRAL_WEEKLY_LEADERBOARD_KEY = 'referral:weekly:leaderboard';
export const REFERRAL_LEADERBOARD_NAMES_KEY = 'referral:names';

export const lastReturnCacheKey = (uid: string) => `investment:lastReturn:${uid}`;
