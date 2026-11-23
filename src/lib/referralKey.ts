import type { Db } from './db/types';
import { isUniqueViolation } from './db/format';

const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomSuffix(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

// Referral keys look like `incossify-a3f9k2`. The unique index on profiles.referral_key is the collision
// check — on the (very unlikely) clash we retry. Idempotent: an existing key is returned untouched.
export async function assignReferralKey(db: Db, uid: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `incossify-${randomSuffix()}`;
    const { data, error } = await db.from('profiles').update({ referral_key: candidate }).eq('id', uid).is('referral_key', null).select('referral_key');

    if (error) {
      if (isUniqueViolation(error, 'profiles_referral_key_key')) continue;
      throw new Error(error.message);
    }
    if (data && data.length) return data[0].referral_key as string;

    const { data: existing } = await db.from('profiles').select('referral_key').eq('id', uid).maybeSingle();
    if (existing?.referral_key) return existing.referral_key as string;
  }
  throw new Error('Could not generate a unique referral key — please try again.');
}
