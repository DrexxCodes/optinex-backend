import type { FastifyPluginAsync } from 'fastify';
import { PLATFORM_TOPIC } from '@/config/constants';
import { HttpError } from '@/lib/errors';
import { bodyOf } from '../helpers';

// Every device subscribes to one topic so the admin can broadcast with a single `send({ topic })`.
// FCM stays purely the push *delivery* channel; the tokens themselves live in Supabase.
const notificationRoutes: FastifyPluginAsync = async (app) => {
  const { db, messaging } = app.c;
  app.addHook('preHandler', app.authenticate);

  app.post('/register', async (req) => {
    const { token, deviceId } = bodyOf(req);
    if (!token || typeof token !== 'string') throw new HttpError(400, 'A push token is required.');

    const now = Date.now();
    const { error } = await db
      .from('push_tokens')
      .upsert({ token, user_id: req.session!.uid, device_id: deviceId ?? null, created_at: now, updated_at: now }, { onConflict: 'token' });
    if (error) {
      console.error('[notifications/register]', error);
      throw new HttpError(500, 'Could not register this device.');
    }

    try {
      await messaging.subscribeToTopic(token, PLATFORM_TOPIC);
    } catch {
      // A stale/invalid token slipping through shouldn't fail the request — the next getToken() retries.
    }
    return { ok: true };
  });

  app.delete('/register', async (req) => {
    const { token } = bodyOf(req);
    if (!token || typeof token !== 'string') throw new HttpError(400, 'A push token is required.');

    const { data } = await db.from('push_tokens').select('user_id').eq('token', token).maybeSingle();
    if (data && data.user_id === req.session!.uid) {
      await messaging.unsubscribeFromTopic(token, PLATFORM_TOPIC).catch(() => {});
      await db.from('push_tokens').delete().eq('token', token);
    }
    return { ok: true };
  });
};
export default notificationRoutes;
