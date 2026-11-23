import type { FastifyPluginAsync } from 'fastify';
import { HttpError, notFound } from '@/lib/errors';
import { iso, num, parseFlatScored, UUID_RE } from '@/lib/db/format';
import { assignReferralKey } from '@/lib/referralKey';
import { REFERRAL_LEADERBOARD_KEY, REFERRAL_LEADERBOARD_NAMES_KEY } from '@/config/redisKeys';

type LeaderboardEntry = { uid: string; fullName: string; username: string; referrals: number; totalEarned: number; rank: number };

const referralRoutes: FastifyPluginAsync = async (app) => {
  const { db, redis } = app.c;
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (req) => {
    const uid = req.session!.uid;
    const { data: user } = await db.from('profiles').select('referral_key, referral_earnings').eq('id', uid).maybeSingle();
    if (!user) throw notFound('User not found.');

    const referralKey: string | null = user.referral_key ?? null;
    let connections = 0;
    let recentConnections: { uid: string; fullName: string; username: string; joinedAt: string | null }[] = [];

    if (referralKey) {
      const { data, count } = await db
        .from('profiles')
        .select('id, full_name, username, created_at', { count: 'exact' })
        .eq('referred_by', uid)
        .order('created_at', { ascending: false })
        .limit(8);

      connections = count ?? data?.length ?? 0;
      recentConnections = (data ?? []).map((r: any) => ({
        uid: r.id,
        fullName: r.full_name || 'Incossify user',
        username: r.username ?? '',
        joinedAt: iso(r.created_at)
      }));
    }

    return { referralKey, connections, totalEarned: num(user.referral_earnings), recentConnections };
  });

  app.post('/generate', async (req) => {
    const uid = req.session!.uid;
    const { data: user } = await db.from('profiles').select('referral_key').eq('id', uid).maybeSingle();
    if (!user) throw notFound('User not found.');

    // Idempotency: if a link already exists, hand it back instead of minting a second one.
    if (user.referral_key) return { referralKey: user.referral_key };

    try {
      return { referralKey: await assignReferralKey(db, uid) };
    } catch (err) {
      console.error('[referral/generate]', err);
      throw new HttpError(500, 'Could not generate a referral key. Please try again.');
    }
  });

  app.get('/leaderboard', async (req) => {
    const uid = req.session!.uid;
    try {
      // Top 10, highest referral count first.
      const top = parseFlatScored(await redis.zrange(REFERRAL_LEADERBOARD_KEY, 0, 9, { rev: true, withScores: true }));
      const uids = top.map((t) => t.member);
      const names = uids.length > 0 ? await redis.hmget(REFERRAL_LEADERBOARD_NAMES_KEY, ...uids) : {};

      // The Redis name cache is best-effort: any uid missing a usable entry falls back to the database
      // (the source of truth) and backfills the cache so it self-heals.
      const missingUids = uids.filter((id) => {
        const cached = names?.[id];
        if (!cached) return true;
        try {
          return !JSON.parse(cached).fullName;
        } catch {
          return true;
        }
      });

      // One query covers the missing names and everyone's earnings (the caller is included for `you`).
      const lookupIds = Array.from(new Set([...uids, uid])).filter((id) => UUID_RE.test(id));
      const { data: rows } = lookupIds.length
        ? await db.from('profiles').select('id, full_name, username, referral_earnings').in('id', lookupIds)
        : { data: [] as any[] };
      const byId = new Map((rows ?? []).map((r: any) => [r.id as string, r]));

      const fetchedNames = new Map<string, { fullName: string; username: string }>();
      for (const id of missingUids) {
        const r = byId.get(id);
        if (r) fetchedNames.set(id, { fullName: r.full_name || 'Incossify user', username: r.username ?? '' });
      }
      if (fetchedNames.size > 0) {
        try {
          const payload: Record<string, string> = {};
          for (const [id, entry] of fetchedNames) payload[id] = JSON.stringify(entry);
          await redis.hset(REFERRAL_LEADERBOARD_NAMES_KEY, payload);
        } catch (err) {
          console.error('[referral/leaderboard] name cache backfill failed:', err);
        }
      }

      const earningsOf = (id: string) => num(byId.get(id)?.referral_earnings);

      const leaderboard: LeaderboardEntry[] = top.map((entry, i) => {
        let fullName = 'Incossify user';
        let username = '';
        const cached = names?.[entry.member];
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed.fullName) {
              fullName = parsed.fullName;
              username = parsed.username ?? username;
            }
          } catch {
            // ignore malformed cache entries
          }
        }
        const fetched = fetchedNames.get(entry.member);
        if (fetched) {
          fullName = fetched.fullName;
          username = fetched.username;
        }
        return { uid: entry.member, fullName, username, referrals: entry.score, totalEarned: earningsOf(entry.member), rank: i + 1 };
      });

      const [yourRank, yourScore] = await Promise.all([redis.zrevrank(REFERRAL_LEADERBOARD_KEY, uid), redis.zscore(REFERRAL_LEADERBOARD_KEY, uid)]);
      const you = yourRank !== null && yourRank !== undefined ? { rank: yourRank + 1, referrals: yourScore ?? 0, totalEarned: earningsOf(uid) } : null;

      return { leaderboard, you };
    } catch (err) {
      console.error('[referral/leaderboard]', err);
      throw new HttpError(500, 'Could not load the leaderboard right now.');
    }
  });
};
export default referralRoutes;
