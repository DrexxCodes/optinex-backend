import type { FastifyPluginAsync } from 'fastify';
import { HttpError } from '@/lib/errors';
import { bodyOf } from '../helpers';

const popupAdminRoutes: FastifyPluginAsync = async (app) => {
  const { config } = app.c;

  app.get('/', async () => {
    const data = (await config.get('popup')) ?? {};
    return {
      enabled: data.enabled === true,
      title: data.title ?? '',
      body: data.body ?? '',
      actionLabel: data.actionLabel ?? '',
      actionLink: data.actionLink ?? ''
    };
  });

  app.put('/', async (req) => {
    const { enabled, title, body, actionLabel, actionLink } = bodyOf(req);

    if (enabled && (!title?.trim() || !body?.trim())) throw new HttpError(400, 'A title and body are required to enable the notification.');
    // The action button is optional, but if one half is set both must be.
    if ((actionLabel?.trim() && !actionLink?.trim()) || (!actionLabel?.trim() && actionLink?.trim())) {
      throw new HttpError(400, 'Set both an action label and link, or leave both empty.');
    }

    await config.merge('popup', {
      enabled: !!enabled,
      title: title?.trim() ?? '',
      body: body?.trim() ?? '',
      actionLabel: actionLabel?.trim() || null,
      actionLink: actionLink?.trim() || null
    });
    return { ok: true };
  });
};
export default popupAdminRoutes;
