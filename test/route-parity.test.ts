import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers/app';

// Generated from the Next.js apps' app/api file trees (user + admin): every handler that existed must still exist
// here at the same method + URL, so the frontends' fetch paths keep working untouched.
const ORIGINAL_ROUTES: [string, string][] = [
  ['DELETE', '/api/admin/investments/packages/:id'],
  ['DELETE', '/api/admin/tasks/:id'],
  ['DELETE', '/api/notifications/register'],
  ['GET', '/api/admin/investments/bank'],
  ['GET', '/api/admin/investments/packages'],
  ['GET', '/api/admin/investments/requests'],
  ['GET', '/api/admin/leaderboard'],
  ['GET', '/api/admin/loans'],
  ['GET', '/api/admin/loans/:id'],
  ['GET', '/api/admin/overview'],
  ['GET', '/api/admin/popup'],
  ['GET', '/api/admin/push'],
  ['GET', '/api/admin/referrals'],
  ['GET', '/api/admin/reset'],
  ['GET', '/api/admin/tasks'],
  ['GET', '/api/admin/upgrade/requests'],
  ['GET', '/api/admin/upgrade/settings'],
  ['GET', '/api/admin/users'],
  ['GET', '/api/admin/users/:id/subscriptions'],
  ['GET', '/api/admin/users/:id/transactions'],
  ['GET', '/api/admin/withdrawals/requests'],
  ['GET', '/api/admin/withdrawals/settings'],
  ['GET', '/api/avatar/:seed'],
  ['GET', '/api/casino/leaderboard'],
  ['GET', '/api/cron/investment-returns'],
  ['GET', '/api/investment/packages'],
  ['GET', '/api/investment/status'],
  ['GET', '/api/loans'],
  ['GET', '/api/popup'],
  ['GET', '/api/referral'],
  ['GET', '/api/referral/leaderboard'],
  ['GET', '/api/streak/history'],
  ['GET', '/api/streak/spin/status'],
  ['GET', '/api/tasks'],
  ['GET', '/api/upgrade/status'],
  ['GET', '/api/user/me'],
  ['GET', '/api/utils/ref-generator'],
  ['GET', '/api/wallet/transactions'],
  ['GET', '/api/withdrawal/banks'],
  ['GET', '/api/withdrawal/status'],
  ['PATCH', '/api/admin/investments/packages/:id'],
  ['PATCH', '/api/admin/investments/requests/:id'],
  ['PATCH', '/api/admin/loans/:id'],
  ['PATCH', '/api/admin/tasks/:id'],
  ['PATCH', '/api/admin/upgrade/requests/:id'],
  ['PATCH', '/api/admin/users/:id'],
  ['PATCH', '/api/admin/users/:id/subscriptions/:subId'],
  ['PATCH', '/api/admin/withdrawals/requests/:id'],
  ['PATCH', '/api/user/me'],
  ['POST', '/api/admin/investments/packages'],
  ['POST', '/api/admin/push'],
  ['POST', '/api/admin/referrals/reset'],
  ['POST', '/api/admin/reset'],
  ['POST', '/api/admin/reset/nuke'],
  ['POST', '/api/admin/tasks'],
  ['POST', '/api/admin/users/:id/wallet'],
  ['POST', '/api/auth/claim-admin'],
  ['POST', '/api/auth/logout'],
  ['POST', '/api/auth/refresh'],
  ['POST', '/api/auth/signin'],
  ['POST', '/api/auth/signup'],
  ['POST', '/api/casino/submit-score'],
  ['POST', '/api/cron/investment-returns'],
  ['POST', '/api/investment/change-package'],
  ['POST', '/api/investment/subscribe'],
  ['POST', '/api/loans/apply'],
  ['POST', '/api/notifications/register'],
  ['POST', '/api/referral/generate'],
  ['POST', '/api/streak/checkin'],
  ['POST', '/api/streak/spin'],
  ['POST', '/api/tasks/:taskId/complete'],
  ['POST', '/api/upgrade/subscribe'],
  ['POST', '/api/withdrawal/payout-method'],
  ['POST', '/api/withdrawal/request'],
  ['POST', '/api/withdrawal/resolve-account'],
  ['PUT', '/api/admin/investments/bank'],
  ['PUT', '/api/admin/popup'],
  ['PUT', '/api/admin/upgrade/settings'],
  ['PUT', '/api/admin/withdrawals/settings']
];

let h: Harness;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => h.app.close());

describe('route parity with the old Next.js API', () => {
  it('covers every original handler (79 unique method+path pairs)', () => {
    const missing = ORIGINAL_ROUTES.filter(([method, url]) => !h.app.hasRoute({ method: method as any, url }));
    expect(missing).toEqual([]);
  });

  it('also serves the UploadThing endpoint', () => {
    expect(h.app.hasRoute({ method: 'POST', url: '/api/uploadthing' })).toBe(true);
    expect(h.app.hasRoute({ method: 'GET', url: '/api/uploadthing' })).toBe(true);
  });
});
