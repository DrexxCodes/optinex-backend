import type { FastifyPluginAsync } from 'fastify';

// Admin-configured welcome dialog shown on dashboard load. config `popup`: { title, body, actionLabel, actionLink, enabled }
const popupRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async () => {
    const data = await app.c.config.get('popup');
    if (!data || data.enabled === false) return { enabled: false };
    return {
      enabled: true,
      title: data.title ?? '',
      body: data.body ?? '',
      actionLabel: data.actionLabel ?? null,
      actionLink: data.actionLink ?? null
    };
  });
};
export default popupRoutes;
