import type { Context, Next } from "hono";
import { env } from "../lib/env.js";
import { redis } from "../lib/redis.js";
import { LOGIN_STEPUP_THRESHOLD, LOGIN_FAIL_TTL_S, extractLoginIdentifier } from "./login-abuse.js";

/**
 * Auth abuse middleware — Cloudflare Turnstile + per-ACCOUNT suspicion step-up.
 *
 * Runs on auth POST endpoints (signup, login, password reset). Behaviour:
 *
 *   • If a `cf-turnstile-response` token is present, verify it against
 *     Cloudflare siteverify (403 on failure). Unchanged from before.
 *
 *   • STEP-UP (credential login only): if an account has failed login too many
 *     times recently, REQUIRE a valid token. A normal user — including one who
 *     can't load the widget (e.g. blocked in CN) — is NOT challenged unless
 *     their OWN account is under attack. This is the big-platform pattern:
 *     lock the account being attacked, not the IP, so shared-IP neighbours are
 *     never punished and IP-rotating credential stuffing is still caught.
 *
 *   • Failure tracking is keyed on the account (email/username) in Redis and
 *     drives the step-up. FAIL-OPEN everywhere: a Redis or siteverify error
 *     must never lock a human out.
 *
 * Turnstile verification is skipped entirely if TURNSTILE_SECRET_KEY is unset.
 *
 *   request ─▶ [parse body] ─▶ failCount(account) ≥ 5 ?
 *                                   │ no  ─▶ verify token IF present ─▶ next()
 *                                   │ yes ─▶ require valid token (else 403) ─▶ next()
 *                              ─▶ [await next()] ─▶ status 401: failCount++ | 2xx: reset
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// POST paths (relative to /api/auth) that accept user input → Turnstile applies.
// NOTE: the password-reset endpoint in Better Auth 1.5.6 is
// `/request-password-reset`. The old `/forget-password` entry never matched a
// real route, so CAPTCHA was silently absent from the reset flow — keep it for
// safety but the live path is `/request-password-reset`.
const PROTECTED_PATHS = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/sign-in/username",
  "/request-password-reset",
  "/forget-password",
]);

// Credential login paths → per-account failure tracking + suspicion step-up.
const LOGIN_PATHS = new Set(["/sign-in/email", "/sign-in/username"]);

const failKey = (id: string) => `loginfail:${id}`;

async function getLoginFailureCount(id: string): Promise<number> {
  if (!redis) return 0;
  try {
    const v = await redis.get(failKey(id));
    return v ? parseInt(v, 10) || 0 : 0;
  } catch {
    return 0; // fail-open — a Redis hiccup must never trigger a lockout
  }
}

async function recordLoginFailure(id: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.incr(failKey(id));
    await redis.expire(failKey(id), LOGIN_FAIL_TTL_S); // rolling window from last failure
  } catch {
    /* best-effort */
  }
}

async function clearLoginFailures(id: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(failKey(id));
  } catch {
    /* best-effort */
  }
}

async function verifyTurnstileToken(token: string, ip: string): Promise<boolean> {
  try {
    const result = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: ip,
      }),
    });
    const outcome = (await result.json()) as { success: boolean };
    return outcome.success === true;
  } catch {
    // siteverify unreachable — fail-open so a Cloudflare outage can't block logins.
    return true;
  }
}

export async function turnstileMiddleware(c: Context, next: Next) {
  if (c.req.method !== "POST") return next();

  const path = c.req.path.replace(/^\/api\/auth/, "");
  if (!PROTECTED_PATHS.has(path)) return next();

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const isLogin = LOGIN_PATHS.has(path);
  const identifier = isLogin ? extractLoginIdentifier(body) : "";

  // Step-up only when this specific account is under attack.
  const requireToken =
    isLogin && identifier
      ? (await getLoginFailureCount(identifier)) >= LOGIN_STEPUP_THRESHOLD
      : false;

  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "";

  const token = body["cf-turnstile-response"] as string | undefined;

  if (env.TURNSTILE_SECRET_KEY) {
    if (token) {
      if (!(await verifyTurnstileToken(token, ip))) {
        return c.json(
          { error: "CAPTCHA verification failed. Please try again.", code: "CAPTCHA_FAILED" },
          403,
        );
      }
    } else if (requireToken) {
      return c.json(
        {
          error: "Too many attempts. Please complete the verification and try again.",
          code: "CAPTCHA_REQUIRED",
        },
        403,
      );
    }
  }

  // Re-inject the body so Better Auth (downstream) can re-read it.
  const newReq = new Request(c.req.url, {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: JSON.stringify(body),
  });
  (c.req as any).raw = newReq;

  // Non-login protected paths need no failure tracking.
  if (!isLogin || !identifier) return next();

  // Login: run the handler, then update the per-account counter from the
  // response STATUS only. Reading status is safe; do NOT call c.header() or
  // rebuild the response here — that would clone it and drop Better Auth's
  // Set-Cookie (see routes/auth.ts). 401 = bad credentials.
  await next();
  const status = c.res?.status ?? 0;
  if (status === 401) {
    await recordLoginFailure(identifier);
  } else if (status >= 200 && status < 300) {
    await clearLoginFailures(identifier);
  }
}
