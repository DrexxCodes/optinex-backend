# optinex-backend

Fastify service that replaces **every** API route of `optinex-user` and `optinex-admin`. It is the only
thing that holds Supabase, Upstash, Firebase-admin, Paystack and UploadThing credentials. The two Next.js
apps contain no database code: they proxy `/api/*` here.

```
browser ──► Next.js app (user or admin) ──/api/* rewrite──► optinex-backend ──► Supabase · Redis · FCM · Paystack · UploadThing
```

## Run

```bash
cp .env.example .env     # fill it (the old NEXT_PUBLIC_SUPABASE_* names are accepted too)
pnpm install
pnpm dev                 # tsx watch on :4000
pnpm test                # 253 tests, no network or credentials needed
pnpm build && pnpm start # or: docker build -t optinex-backend .
```

Point each Next app at it with `BACKEND_URL=http://localhost:4000` (see the apps' `.env.example`).

## How auth works

- `POST /api/auth/signin|signup` verify credentials against Supabase Auth **server-side** and set two
  httpOnly cookies (`optinex_at`, `optinex_rt`). The browser never sees a Supabase URL, key or token.
- Every protected route verifies the access token (Supabase JWKS, cached; short in-memory claims cache).
- `POST /api/auth/refresh` rotates the cookies (the apps call it on a 401 and from their proxy middleware).
- `/api/admin/*` is behind `requireAdmin`: valid session **and** `profiles.is_admin = true`, checked live.
  No session → 401 (so the client can silently refresh); signed in but not admin → 403.

## Layout

```
src/
  config/      env (zod), constants, prizes, loan stages, redis keys
  lib/         clients (supabase, auth gateway, redis, fcm, paystack), db repos, limiters, validators
  plugins/     security (helmet/cors/rate-limit), auth (authenticate/requireAdmin), error handler
  modules/     one folder per domain: auth, profile, avatar, popup, notifications, utils, casino, investment,
               loans, referral, streak, tasks, upgrade, wallet, withdrawal, uploads, cron, admin/*
  routes/      mounts every module under the same URLs the Next.js routes used
  container.ts composition root (tests swap the clients for in-memory fakes)
test/          fakes for Supabase/Redis/Auth + route, security and lib tests
```

## Abuse protection

Global per-IP limit · per-user limit · per-IP sign-in/sign-up/refresh caps with a temporary **ban** for
clients that keep hammering · per-email sign-in cap (Redis) · the original Redis per-user limits on loans /
bank lookups · 100 KB body limit · helmet headers · request timeouts · 15 s timeout on every Supabase call.
All thresholds are env vars (see `.env.example`).

## Operational notes

- **Single instance.** In-memory limiters assume one server/container (as planned). Scale out → move them to Redis.
- **Supabase Auth rate limits are per IP.** All sign-ins now originate from this server's IP, so raise
  *Authentication → Rate Limits* in the Supabase dashboard (sign-ups/sign-ins per 5 min per IP) well above the default.
- **Timezone.** Set `TZ` to what the old Next servers used (analytics day keys use the local date).
- **UploadThing callback.** Set `UPLOADTHING_CALLBACK_URL` to `<user app domain>/api/uploadthing`; the app's rewrite forwards it here.
- **Cron.** `/api/cron/investment-returns` needs `Authorization: Bearer $CRON_SECRET`; the old localhost bypass is gone on purpose.
- The Postgres functions (`daily_checkin`, `spin`, `request_withdrawal`, …) are unchanged and already deployed; tests stub them.

## One-off scripts

`scripts/` holds the Firebase → Supabase migration tools that used to sit in `optinex-user` (they need
`firebase-admin`, `@supabase/supabase-js` and `@upstash/redis`, which this repo already has). Run them with
`npx tsx scripts/migrate-firebase-to-supabase.ts --dry-run`. They are not part of the server build.
