import type { FastifyPluginAsync } from 'fastify';
import { HttpError } from '@/lib/errors';
import { generateAvatarSvg } from '@/lib/dicebear';
import { paramsOf } from '../helpers';

// Public: the avatar is a pure function of the (lowercased) email seed. Rendered by our own server so no
// request leaves for api.dicebear.com; safe to cache for a year.
const avatarRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:seed', async (req, reply) => {
    const seed = decodeURIComponent(paramsOf(req).seed ?? '');
    if (!seed || seed.length > 254) throw new HttpError(400, 'Invalid avatar seed.');

    return reply
      .header('Content-Type', 'image/svg+xml')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(generateAvatarSvg(seed));
  });
};
export default avatarRoutes;
