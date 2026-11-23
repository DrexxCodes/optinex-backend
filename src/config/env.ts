// Single, validated view of the environment. Existing Next.js variable names (NEXT_PUBLIC_SUPABASE_*)
// are accepted as fallbacks so the old .env values can be copied over unchanged.
import { z } from 'zod';

const optionalString = z.string().min(1).optional();
const int = (def: number) => z.coerce.number().int().min(0).default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // 'true' when the backend sits behind the Next.js rewrite / a load balancer, so req.ip is the real client.
  TRUST_PROXY: z.string().default('false'),
  CORS_ORIGINS: z.string().default(''),

  COOKIE_SECURE: z.string().optional(),
  COOKIE_DOMAIN: optionalString,

  SUPABASE_URL: z.url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  UPSTASH_REDIS_REST_URL: z.url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),

  FIREBASE_PROJECT_ID: optionalString,
  FIREBASE_CLIENT_EMAIL: optionalString,
  FIREBASE_PRIVATE_KEY: optionalString,

  PAYSTACK_SECRET_KEY: optionalString,
  CRON_SECRET: optionalString,

  UPLOADTHING_TOKEN: optionalString,
  UPLOADTHING_CALLBACK_URL: optionalString,

  // ── Abuse protection (all per-IP unless noted) ──
  RATE_LIMIT_GLOBAL_MAX: int(300), // requests / minute / IP, every route
  RATE_LIMIT_USER_MAX: int(240), // requests / minute / signed-in user (in-memory)
  RATE_LIMIT_SIGNIN_MAX: int(30), // sign-in attempts / minute / IP
  RATE_LIMIT_SIGNIN_EMAIL_MAX: int(10), // sign-in attempts / 15 min / email (Redis)
  RATE_LIMIT_SIGNUP_MAX: int(20), // sign-ups / hour / IP
  RATE_LIMIT_REFRESH_MAX: int(60), // session refreshes / minute / IP (each one costs a Supabase call)
  RATE_LIMIT_BAN_AFTER: int(25), // auth routes: 403 for the window after this many over-limit hits (0 = off)
  BODY_LIMIT_BYTES: int(100_000)
});

export type Env = Omit<z.infer<typeof schema>, 'COOKIE_SECURE'> & { COOKIE_SECURE: boolean };

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Treat blank values (KEY=) as unset and map the legacy Next.js names.
  const cleaned: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) cleaned[k] = v === '' ? undefined : v;

  const raw = {
    ...cleaned,
    SUPABASE_URL: cleaned.SUPABASE_URL ?? cleaned.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY:
      cleaned.SUPABASE_PUBLISHABLE_KEY ?? cleaned.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? cleaned.NEXT_PUBLIC_SUPABASE_ANON_KEY
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  const d = parsed.data;
  const secure = d.COOKIE_SECURE === undefined ? d.NODE_ENV === 'production' : d.COOKIE_SECURE === 'true' || d.COOKIE_SECURE === '1';
  return { ...d, COOKIE_SECURE: secure };
}
