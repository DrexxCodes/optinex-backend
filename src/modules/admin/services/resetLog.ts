import type { ConfigRepo } from '@/lib/db/config';
import { CASINO_GAME_IDS, type CasinoGameId } from '@/config/constants';

export type ResetLogCategory = 'financial' | 'checkin' | 'signup' | 'referral' | 'withdrawals' | 'nuke';
type StoredLog = Partial<Record<ResetLogCategory, string>> & { game?: Partial<Record<CasinoGameId | 'all', string>> };

export type ResetLog = {
  financial: string | null;
  checkin: string | null;
  signup: string | null;
  referral: string | null;
  withdrawals: string | null;
  nuke: string | null;
  game: Record<CasinoGameId | 'all', string | null>;
};

// Records "this got reset just now" in the `resetLog` config row (ISO timestamps).
export function createResetLog(config: ConfigRepo) {
  return {
    async record(category: ResetLogCategory) {
      await config.merge('resetLog', { [category]: new Date().toISOString() });
    },
    async recordGame(gameId: CasinoGameId | 'all') {
      const existing = (await config.get<StoredLog>('resetLog'))?.game ?? {};
      await config.merge('resetLog', { game: { ...existing, [gameId]: new Date().toISOString() } });
    },
    async get(): Promise<ResetLog> {
      const data = (await config.get<StoredLog>('resetLog')) ?? {};
      const toIso = (v: unknown): string | null => (typeof v === 'string' && v ? new Date(v).toISOString() : null);

      const game = {} as Record<CasinoGameId | 'all', string | null>;
      for (const id of [...CASINO_GAME_IDS, 'all' as const]) game[id] = toIso(data.game?.[id]);

      return {
        financial: toIso(data.financial),
        checkin: toIso(data.checkin),
        signup: toIso(data.signup),
        referral: toIso(data.referral),
        withdrawals: toIso(data.withdrawals),
        nuke: toIso(data.nuke),
        game
      };
    }
  };
}
