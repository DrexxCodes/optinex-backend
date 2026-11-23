import type { FastifyPluginAsync } from 'fastify';
import type { FastifyRequest } from 'fastify';
import { createRouteHandler, createUploadthing, type FileRouter } from 'uploadthing/fastify';
import { COOKIE_ACCESS } from '@/config/constants';

// Receipt uploads. The browser talks to this via the app's /api/uploadthing rewrite; UploadThing's
// servers call back to UPLOADTHING_CALLBACK_URL (the app's public /api/uploadthing URL) when done.
const uploadRoutes: FastifyPluginAsync = async (app) => {
  const { env, auth } = app.c;
  const f = createUploadthing();

  const sessionOf = async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : req.cookies?.[COOKIE_ACCESS];
    return token ? auth.verify(token) : null;
  };

  const router = {
    paymentReceipt: f({ image: { maxFileSize: '4MB', maxFileCount: 1 }, pdf: { maxFileSize: '4MB', maxFileCount: 1 } })
      .middleware(async ({ req }) => {
        const claims = await sessionOf(req);
        if (!claims) throw new Error('Unauthenticated.');
        return { uid: claims.sub };
      })
      .onUploadComplete(async ({ metadata, file }) => {
        console.log(`[uploadthing] receipt uploaded by ${metadata.uid}: ${file.ufsUrl}`);
        return { uid: metadata.uid, url: file.ufsUrl };
      })
  } satisfies FileRouter;

  await app.register(createRouteHandler, {
    router,
    config: { token: env.UPLOADTHING_TOKEN, callbackUrl: env.UPLOADTHING_CALLBACK_URL }
  });
};
export default uploadRoutes;
