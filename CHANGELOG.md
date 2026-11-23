# Changelog

## 1.0.0 — Fastify backend extracted from optinex-user + optinex-admin

### Added
- Fastify 5 service exposing every former Next.js route (all 82 handlers across both apps (see test/route-parity.test.ts)) at the **same URLs**.
- Server-side session handling: httpOnly `optinex_at` / `optinex_rt` cookies set by the backend; Supabase JWTs are
  verified on each request. New endpoints: `GET /api/auth/session`, signup now also signs the user in.
- Abuse protection: global + per-user + per-route rate limits, temporary bans on auth routes, per-email sign-in
  cap, body-size limit, helmet, request/upstream timeouts, generic 500s (no internals leaked).
- 253 automated tests (route parity with the old API, auth, admin guard on every admin route, 401 on every user route, rate limits, sync logic).
- Dockerfile, `.env.example`, README.

### Behaviour changes (intentional)
- `/api/admin/*` and `/api/auth/session` return **401** (not 403) when there is no valid session, so the client's
  silent refresh-and-retry works; **403** is kept for signed-in non-admins.
- Cron route: removed the `hostname === 'localhost'` bypass (spoofable / always true behind a same-host proxy).
  `CRON_SECRET` is required; with no secret configured the route is closed.
- `POST /api/auth/signin` now takes `{ email, password }` (credentials are verified by the backend) instead of being
  a post-login hook. It still runs the analytics event + investment catch-up. Admin sign-in shares this endpoint, so it
  also runs the (idempotent) catch-up if that admin happens to hold a package.
- Sign-up input length caps (password ≤128, email ≤254, username ≤50, name ≤100); `PATCH /api/user/me` caps the name at 100.
- Paystack bank list cached 24 h in memory (replaces Next's `revalidate`); account resolution returns 422 instead of a
  500 when Paystack answers without an account name.
- Avatar route is rate-limited like everything else and cached in an LRU.
- `@dicebear/core` + `@dicebear/collection` pinned to 9.4.3: collection's latest (9.4.x) peers on core ^9, and 9.x keeps
  every existing avatar byte-identical. Everything else is on current releases.
