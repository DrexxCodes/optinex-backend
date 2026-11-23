import type { FastifyPluginAsync } from 'fastify';
import { PLATFORM_TOPIC } from '@/config/constants';
import { HttpError } from '@/lib/errors';
import { bodyOf } from '../helpers';

// Every registered device subscribes to PLATFORM_TOPIC, so one `send({ topic })` reaches every user with push on.
const pushAdminRoutes: FastifyPluginAsync = async (app) => {
  const { db, messaging } = app.c;

  app.get('/', async () => {
    const { data } = await db.from('push_notifications').select('id, title, body, link, sent_by, sent_at').order('sent_at', { ascending: false }).limit(20);
    return {
      notifications: (data ?? []).map((n: any) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        link: n.link ?? null,
        sentBy: n.sent_by ?? null,
        sentAt: n.sent_at ? new Date(n.sent_at).getTime() : null
      }))
    };
  });

  app.post('/', async (req) => {
    const { title, body, link } = bodyOf(req);
    if (!title?.trim() || !body?.trim()) throw new HttpError(400, 'A title and body are required.');

    let messageId: string;
    try {
      messageId = await messaging.send({
        topic: PLATFORM_TOPIC,
        notification: { title: title.trim(), body: body.trim() },
        webpush: {
          // Icon paths resolve against the origin that owns the service worker (the user app).
          notification: { icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' },
          fcmOptions: link?.trim() ? { link: link.trim() } : undefined
        }
      });
    } catch {
      throw new HttpError(502, 'Could not send the push notification.');
    }

    const { data } = await db
      .from('push_notifications')
      .insert({ title: title.trim(), body: body.trim(), link: link?.trim() || null, sent_by: req.admin!.email })
      .select('id')
      .single();

    return { ok: true, id: data?.id ?? null, messageId };
  });
};
export default pushAdminRoutes;
