import type { FastifyPluginAsync } from 'fastify';
import { HttpError, notFound } from '@/lib/errors';
import { generateReference } from '@/lib/refGenerator';
import { iso, num } from '@/lib/db/format';
import { bodyOf } from '../helpers';

const investmentRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, analytics } = app.c;
  app.addHook('preHandler', app.authenticate);

  // Admin-created packages. Every account starts on the implicit `Free` tier which never appears here.
  app.get('/packages', async () => {
    const { data } = await db.from('packages').select('id, name, price, duration, details').eq('active', true).order('price', { ascending: true });
    return {
      packages: (data ?? []).map((p: any) => ({ id: p.id, name: p.name, price: num(p.price), duration: p.duration, details: p.details ?? [] }))
    };
  });

  // Bank details for the payment dialog + the user's latest request (drives the "pending verification" badge).
  app.get('/status', async (req) => {
    const uid = req.session!.uid;
    const [bank, latestRes, userRes] = await Promise.all([
      config.get('bank'),
      db.from('investments').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(1),
      db.from('profiles').select('package_status, package_id, package_name, is_changing_package').eq('id', uid).maybeSingle()
    ]);

    const l = latestRes.data?.[0];
    const latest = l
      ? {
          id: l.id,
          uid: l.user_id,
          packageId: l.package_id,
          packageName: l.package_name,
          amount: num(l.amount),
          receiptUrl: l.receipt_url,
          status: l.status,
          reference: l.reference,
          isPackageChange: l.is_package_change,
          previousPackageId: l.previous_package_id,
          createdAt: iso(l.created_at)
        }
      : null;
    const user = userRes.data;

    return {
      bank: bank ? { bankName: bank.bankName, accountNumber: bank.accountNumber, accountName: bank.accountName } : null,
      latestRequest: latest,
      packageStatus: user?.package_status ?? 'Free',
      packageId: user?.package_id ?? null,
      packageName: user?.package_name ?? undefined,
      isChangingPackage: user?.is_changing_package ?? false
    };
  });

  // Called after the receipt is uploaded via UploadThing: creates a pending request and flips the user's
  // package status so the withdrawal gatekeeper and dashboard badge both show "pending verification".
  app.post('/subscribe', async (req) => {
    const uid = req.session!.uid;
    const { packageId, receiptUrl } = bodyOf(req);
    if (!packageId || !receiptUrl) throw new HttpError(400, 'A package and receipt are required.');

    const { data: pkg } = await db.from('packages').select('name, price').eq('id', String(packageId)).maybeSingle();
    if (!pkg) throw notFound('Package not found.');

    const reference = generateReference();
    const { data: inv, error } = await db
      .from('investments')
      .insert({
        user_id: uid,
        package_id: String(packageId),
        package_name: pkg.name,
        amount: pkg.price,
        receipt_url: receiptUrl,
        status: 'pending',
        reference
      })
      .select('id')
      .single();
    if (error || !inv) {
      console.error('[investment/subscribe]', error);
      throw new HttpError(500, 'Could not submit your investment.');
    }

    await db.from('profiles').update({ package_status: 'pending verification' }).eq('id', uid);
    await analytics.safeLog('investment_submitted', num(pkg.price), 'investment');

    return { ok: true, reference, investmentId: inv.id };
  });

  // Lets a user with an active investment change package: creates a new request and marks them as changing.
  app.post('/change-package', async (req) => {
    const uid = req.session!.uid;
    const { packageId, receiptUrl } = bodyOf(req);
    if (!packageId || !receiptUrl) throw new HttpError(400, 'A package and receipt are required.');

    const { data: user } = await db.from('profiles').select('package_status, package_id').eq('id', uid).maybeSingle();
    if (!user) throw notFound('User not found.');

    if (user.package_status === 'Free' || !user.package_status || user.package_status === 'pending verification') {
      throw new HttpError(400, 'You must have an active package to change packages.');
    }

    const { data: pkg } = await db.from('packages').select('name, price').eq('id', String(packageId)).maybeSingle();
    if (!pkg) throw notFound('Package not found.');

    const reference = generateReference();
    const { data: inv, error } = await db
      .from('investments')
      .insert({
        user_id: uid,
        package_id: String(packageId),
        package_name: pkg.name,
        amount: pkg.price,
        receipt_url: receiptUrl,
        status: 'pending',
        reference,
        is_package_change: true,
        previous_package_id: user.package_id
      })
      .select('id')
      .single();
    if (error || !inv) {
      console.error('[investment/change-package]', error);
      throw new HttpError(500, 'Could not submit your package change.');
    }

    await db.from('profiles').update({ package_status: 'pending verification', is_changing_package: true }).eq('id', uid);
    await analytics.safeLog('package_change_submitted', num(pkg.price), 'investment');

    return { ok: true, reference, investmentId: inv.id };
  });
};
export default investmentRoutes;
