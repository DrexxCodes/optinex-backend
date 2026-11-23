// Key/value app config (popup, bank, upgrade, withdrawal, resetLog, referralWeekly).
import type { Db } from './types';

export type ConfigKey = 'popup' | 'bank' | 'upgrade' | 'withdrawal' | 'resetLog' | 'referralWeekly';

export function createConfigRepo(db: Db) {
  return {
    async get<T = Record<string, any>>(key: ConfigKey): Promise<T | null> {
      const { data, error } = await db.from('config').select('value').eq('key', key).maybeSingle();
      if (error) throw new Error(error.message);
      return (data?.value as T) ?? null;
    },
    /** Shallow merge into the stored value (same semantics as Firestore `set(..., { merge: true })`). */
    async merge(key: ConfigKey, value: Record<string, unknown>) {
      const { error } = await db.rpc('merge_config', { p_key: key, p_value: value });
      if (error) throw new Error(error.message);
    }
  };
}
export type ConfigRepo = ReturnType<typeof createConfigRepo>;
