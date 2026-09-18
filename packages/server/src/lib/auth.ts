import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username } from "better-auth/plugins/username";
import { jwt } from "better-auth/plugins/jwt";
import { and, eq, like } from "drizzle-orm";
import { env, IS_LOCAL_EDITION, PUBLIC_ORIGIN } from "./env.js";
import * as schema from "../db/schema.js";
import { db } from "../db/index.js";
import {
  sendEmail,
  verificationEmailHtml,
  verificationEmailText,
  resetPasswordEmailHtml,
  resetPasswordEmailText,
} from "./email.js";
import { ensureWallet } from "./credit-service.js";
import { redis } from "./redis.js";
import {
  AccountDeletionBlockedError,
  permanentlyDeleteAccount,
} from "./account-deletion.js";
import {
  getDeletedIdentity,
  rejectBannedDeletedIdentityAfterCreate,
} from "./deleted-identity.js";
import { isDeletedIdentityRegistrationBlocked } from "./deleted-identity-policy.js";
import { sendRedditConversion } from "./reddit-capi.js";
import { invalidateSessionUser } from "./session-user-cache.js";

/**
 * Server-side ad-conversion for a fresh signup (Reddit CAPI). The browser
 * pixel misses ad-blocked/ITP sessions and in-app-webview → external-browser
 * hops — this path always fires. conversion_id = user id matches the client
 * pixel SignUp's conversionId (lib/analytics.ts) so Reddit dedupes the pair.
 * Match keys (click-id cookie, IP, UA) come from the signup request when the
 * hook context exposes it; email+external_id matching still works without.
 * Fire-and-forget — never blocks or fails account creation.
 */
function reportSignupConversion(user: { id: string; email?: string | null }, ctx: unknown): void {
  try {
    const c = ctx as { headers?: Headers; request?: Request; context?: { headers?: Headers } } | undefined;
    const headers = c?.headers ?? c?.request?.headers ?? c?.context?.headers;
    const cookies = headers?.get?.("cookie") ?? "";
    const cid = /(?:^|;\s*)_rdt_cid=([^;]+)/.exec(cookies)?.[1];
    const ruuid = /(?:^|;\s*)_rdt_uuid=([^;]+)/.exec(cookies)?.[1];
    sendRedditConversion({
      eventType: "SignUp",
      conversionId: user.id,
      email: user.email ?? null,
      externalId: user.id,
      clickId: cid ? decodeURIComponent(cid) : null,
      rdtUuid: ruuid ? decodeURIComponent(ruuid) : null,
      ipAddress:
        headers?.get?.("cf-connecting-ip") ??
        headers?.get?.("x-forwarded-for")?.split(",")[0]?.trim() ??
        null,
      userAgent: headers?.get?.("user-agent") ?? null,
    });
  } catch {
    // ad telemetry must never interfere with signup
  }
}

function assertDeletedIdentityCanRegister(
  deletedIdentity: Awaited<ReturnType<typeof getDeletedIdentity>>,
): void {
  if (isDeletedIdentityRegistrationBlocked(deletedIdentity)) {
    throw new APIError("FORBIDDEN", {
      code: "ACCOUNT_UNAVAILABLE",
      message: "This account cannot be created. Contact support if you believe this is an error.",
    });
  }
}

// Cookie prefix is bumped from Better Auth's default ("better-auth") to
// "yumina" so that when we move from host-only cookies (yumina.io) to
// shared-domain cookies (Domain=.yumina.io), the new cookies have a
// DIFFERENT name from any legacy cookies still in users' browsers.
// Without this, browsers send both cookies with the same name and Better
// Auth picks the wrong one — which is what broke the first attempt at
// this migration. Existing sessions are invalidated as a one-time cost
// of the migration; the legacy-cookie cleanup middleware actively
// expires the old cookies for ~3 weeks post-deploy. Keep this in sync
// with the cookie regex in middleware/auth.ts.
export const COOKIE_PREFIX = "yumina";

/** True when APP_URL points at a yumina.io-family host. Drives the
 * cross-subdomain cookie behavior — only real production (where yumina.io
 * and creator.yumina.io need to share sessions) gets `Domain=.yumina.io`
 * cookies. PR previews and testing on *.up.railway.app fall through to
 * host-scoped cookies so login actually works there. */
function isYuminaHostedAppUrl(appUrl: string | undefined | null): boolean {
  if (!appUrl) return false;
  try {
    const host = new URL(appUrl).hostname.toLowerCase();
    return host === "yumina.io" || host.endsWith(".yumina.io");
  } catch {
    return false;
  }
}

// Better Auth's secondaryStorage is used for rate-limit counters, keeping them
// shared across Railway instances and persisted across restarts. Sessions stay
// in Postgres (Better Auth's default with secondaryStorage configured).
//
// Adapter is fail-soft: on Redis error we log and degrade to "no entry" so a
// transient Redis outage can't lock anyone out.
const RATE_LIMIT_KEY_PREFIX = "ba:rl:";

const redisSecondaryStorage = (() => {
  const client = redis;
  if (!client) return undefined;
  return {
    async get(key: string): Promise<string | null> {
      try {
        return await client.get(RATE_LIMIT_KEY_PREFIX + key);
      } catch (err) {
        console.error("[auth] redis get failed:", err);
        return null;
      }
    },
    async set(key: string, value: string, ttl?: number): Promise<void> {
      try {
        await client.set(RATE_LIMIT_KEY_PREFIX + key, value, "EX", ttl && ttl > 0 ? ttl : 3600);
      } catch (err) {
        console.error("[auth] redis set failed:", err);
      }
    },
    async delete(key: string): Promise<void> {
      try {
        await client.del(RATE_LIMIT_KEY_PREFIX + key);
      } catch (err) {
        console.error("[auth] redis del failed:", err);
      }
    },
  };
})();

/**
 * Generate a unique username for OAuth users who sign up without one.
 * Sanitizes the display name → lowercase alphanumeric + underscores,
 * then appends a random suffix if the base is taken.
 */
async function generateUniqueUsername(name: string | undefined, email: string): Promise<string> {
  // Derive base from display name, fall back to email prefix
  const raw = name?.trim() || email.split("@")[0] || "user";
  let base = raw.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 15);
  if (base.length < 3) base = "user" + base;

  // Check if base is available
  const existing = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.username, base))
    .limit(1);

  if (existing.length === 0) return base;

  // Append random digits until unique
  for (let i = 0; i < 10; i++) {
    const candidate = `${base}${Math.floor(Math.random() * 10000)}`;
    const taken = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.username, candidate))
      .limit(1);
    if (taken.length === 0) return candidate;
  }

  // Last resort — timestamp suffix
  return `${base}${Date.now() % 100000}`;
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      jwks: schema.jwks,
    },
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: process.env.NODE_ENV !== "production"
    ? ["*"]
    : [
        PUBLIC_ORIGIN,
        env.APP_URL,
        env.BETTER_AUTH_URL,
        "https://yumina.io",
        "https://www.yumina.io",
        "https://creator.yumina.io",
      ].filter(Boolean),
  // Cookie domain + prefix logic:
  //
  // Cookie PREFIX ("yumina") MUST be applied everywhere — it's what tells
  // Better Auth to use `__Secure-yumina.*` cookie names. The legacy-cookie
  // cleanup middleware actively expires `__Secure-better-auth.*` on every
  // request, so any environment that falls back to Better Auth's default
  // names will have its sessions nuked one request after login.
  //
  // Cookie DOMAIN (.yumina.io) is the conditional bit:
  //   • On real production (`yumina.io` / `creator.yumina.io`) we scope
  //     cookies to `.yumina.io` so sessions are shared across subdomains.
  //   • On Railway PR previews + the testing env (`*.up.railway.app` or
  //     any host outside the yumina.io family) we leave the domain
  //     unset — the browser scopes the cookie to whatever host issued
  //     it, so login actually works there. Setting `Domain=.yumina.io`
  //     on a `*.up.railway.app` response makes the browser silently
  //     reject the Set-Cookie header.
  //   • The check uses `APP_URL` rather than `NODE_ENV` because Railway
  //     PR previews run with `NODE_ENV=production` for static-file
  //     serving but live on a non-yumina.io host. Tying cookie domain
  //     to the actual hostname is more robust.
  advanced: {
    cookiePrefix: COOKIE_PREFIX,
    defaultCookieAttributes: {
      sameSite: "lax",
      secure: true,
    },
    // Better Auth defaults to `x-forwarded-for[0]`, which behind Cloudflare →
    // Railway is the Cloudflare EDGE ip, not the visitor. Every one of the
    // ~13k session rows in prod carried a CF range (172.68-71, 162.158/159,
    // 104.22/23, 108.162, 141.101, 198.41), so `session.ip_address` was pure
    // noise — and the Settings → Login devices list would have shown the same
    // fake IP for every device. `cf-connecting-ip` is set by Cloudflare and
    // cannot be spoofed by the client through our edge; the x-forwarded-for
    // fallback keeps local dev and non-CF environments working.
    ipAddress: {
      ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
    },
    ...(isYuminaHostedAppUrl(env.APP_URL)
      ? {
          crossSubDomainCookies: {
            enabled: true,
            domain: ".yumina.io",
          },
        }
      : {}),
  },
  user: {
    deleteUser: {
      enabled: true,
      deleteTokenExpiresIn: 60 * 60,
      beforeDelete: async (authUser) => {
        try {
          await permanentlyDeleteAccount(authUser.id);
        } catch (error) {
          if (error instanceof AccountDeletionBlockedError) {
            throw new APIError("CONFLICT", {
              code: error.code,
              message: error.message,
            });
          }
          console.error(`[auth] Account deletion failed for ${authUser.id}:`, error);
          throw new APIError("INTERNAL_SERVER_ERROR", {
            code: "ACCOUNT_DELETION_FAILED",
            message: "Account deletion failed. Try again later or contact support.",
          });
        }
      },
    },
  },
  // Implicit account linking by email: signing in via a social provider with
  // an email that matches an existing user logs into that user's account
  // (instead of creating a duplicate). Better Auth's rule: link when the
  // provider asserts the email is verified, OR the provider is "trusted".
  // Only Google is trusted — Google always returns email_verified. Discord and
  // X can carry UNVERIFIED addresses, and a trusted-but-unverified link lets a
  // stranger attach their Discord/X to someone else's account by typing that
  // person's email (account takeover). Since 2026-09 the linked provider ids
  // are also handed to krew.io as proof of legacy-account ownership
  // (routes/partners.ts), so this gate protects krew players' assets too.
  // Discord/X still link fine when their email IS verified.
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
      // Settings → "Connect Google/Discord" while signed in: the user proves
      // control of both accounts (live session + completed OAuth), so the
      // provider's email need not match the account email. Without this,
      // players who made their Yumina account with a different email than the
      // Google/Discord they used on krew.io can never link it — and that link
      // is how they recover their krew account. Does not affect sign-in-by-
      // email auto-linking, which stays governed by trustedProviders above.
      allowDifferentEmails: true,
    },
  },
  secondaryStorage: redisSecondaryStorage,
  // Deletion links and other verification tokens must survive a transient
  // Redis failure. Better Auth otherwise stores them only in secondaryStorage.
  verification: {
    storeInDatabase: true,
  },
  session: {
    // CRITICAL: when secondaryStorage is set, Better Auth defaults to writing
    // sessions to Redis only. Setting this to true keeps Postgres as the
    // durable source of truth and uses Redis as a cache. Without it, any
    // Redis eviction / restart / transient error logs users out.
    storeSessionInDatabase: true,
    expiresIn: 60 * 60 * 24 * 30,  // 30 days (Better Auth default is only 7)
    updateAge: 60 * 60 * 24,        // refresh session once per day
    // Short-lived signed-cookie session cache. Lets get-session resolve from a
    // signed cookie instead of a DB/Redis round-trip for `maxAge` seconds, so a
    // mobile tab-resume / BFCache thaw / brief network blip on the client no
    // longer momentarily resolves session=null and flashes the UI logged-out
    // (the symptom the auth-client.ts 30s cache + app-shell 5s deferred-clear
    // band-aids were papering over). 5 min keeps revocation / role changes
    // propagating quickly — a full DB/Redis lookup resumes once the cache lapses.
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes
    },
  },
  rateLimit: {
    // Per-IP login throttle. Better Auth's default is 3-per-10s on all
    // /sign-in/* routes, which is too tight for shared IPs (carrier-grade NAT,
    // common for CN/HK users) — several real people behind one IP trip it.
    // We relax it because the real brute-force defense is now per-ACCOUNT
    // (middleware/turnstile.ts: step-up Turnstile after repeated failures on
    // a single account, which is NAT-safe and catches IP-rotating stuffing).
    // OAuth exposes no credentials to brute force, so it keeps the most room.
    customRules: {
      // Exact key required: the endpoint is POST /sign-in/social (provider in
      // the body, no sub-path), and Better Auth's wildcard matcher does NOT
      // match "/sign-in/social" against "/sign-in/social/*" — the old
      // wildcard-only key silently fell through to the built-in 3-per-10s rule.
      "/sign-in/social": { window: 10, max: 20 },
      "/sign-in/social/*": { window: 10, max: 20 },
      "/sign-in/email": { window: 10, max: 10 },
      "/sign-in/username": { window: 10, max: 10 },
      // Better Auth's built-in special rule caps ALL /sign-up* at 3 per 10s
      // per IP — several real people behind one carrier NAT trip it. Same
      // NAT-safety reasoning as sign-in above; per-account/email defenses
      // (Turnstile, email verification, unique constraints) carry the abuse load.
      "/sign-up/email": { window: 10, max: 20 },
      // Every signup requires email verification; the built-in default is
      // 3 per 60s per IP, shared by everyone behind a NAT — stranding users
      // at the verification wall during traffic spikes.
      "/send-verification-email": { window: 60, max: 15 },
      // Password reset: override Better Auth's stingy built-in 3-per-60s-per-IP
      // rule, which would block VPN / carrier-NAT users who share an exit IP
      // (several real people behind one IP resetting in the same minute). The
      // real anti-bombing control is the NAT-safe PER-EMAIL cap in
      // routes/auth.ts; this per-IP ceiling is deliberately generous and only
      // bounds a runaway script.
      "/request-password-reset": { window: 60, max: 20 },
      // The SPA calls get-session on every page load; Better Auth's default
      // 100-per-10s-per-IP cap can flip session checks to 429 on large
      // carrier NATs during a traffic spike, which renders as a logout flash.
      // It's cheap to serve (cookieCache + Redis), so give it real headroom.
      "/get-session": { window: 10, max: 800 },
    },
  },
  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 20,
    }),
    // Asymmetric signing keys + /api/auth/jwks. Used ONLY by the partner
    // identity token (routes/partners.ts → auth.api.signJWT). RS256 rather
    // than the EdDSA default because krew verifies with `jsonwebtoken`, which
    // has no EdDSA support, and already has RS256+JWKS code for Google tokens.
    // disableSettingJwtHeader: the plugin would otherwise sign a fresh JWT on
    // EVERY /get-session response (a DB key read + RSA sign per call) — we
    // never consume that header.
    jwt({
      jwks: { keyPairConfig: { alg: "RS256", modulusLength: 2048 } },
      jwt: { issuer: new URL(env.BETTER_AUTH_URL).origin, expirationTime: "15m" },
      disableSettingJwtHeader: true,
    }),
  ],
  emailAndPassword: {
    enabled: true,
    // Hosted production only. The local edition has no mail provider by default
    // and its single account is created verified (routes/local-auth.ts).
    requireEmailVerification: process.env.NODE_ENV === "production" && !IS_LOCAL_EDITION,
    // Kill every session when a password is reset through the emailed link.
    // Settings → Change password already passes `revokeOtherSessions: true`,
    // but the forgot-password flow is the one people reach for when they think
    // someone else is in their account — and Better Auth leaves those sessions
    // alive unless this flag is on. Sessions last 30 days, so without it the
    // intruder simply stays logged in through the reset.
    revokeSessionsOnPasswordReset: true,
    // Reset-link lifetime stays at Better Auth's 1-hour default on purpose: the
    // single-active-token invariant in databaseHooks.verification below (a new
    // request invalidates all prior links) is what actually closes the
    // stale-link risk, so there's no need to shorten the window and inconvenience
    // someone who gets back to their inbox a little later.
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Reset your Yumina password",
        html: resetPasswordEmailHtml(url, user.name),
        text: resetPasswordEmailText(url, user.name),
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      if (process.env.NODE_ENV !== "production") {
        console.log(`[auth] Verification link for ${user.email}:\n${url}\n`);
      }
      await sendEmail({
        to: user.email,
        subject: "Verify your Yumina account",
        html: verificationEmailHtml(url, user.name),
        text: verificationEmailText(url, user.name),
      });
    },
  },
  databaseHooks: {
    verification: {
      create: {
        // Single-active-reset-token invariant.
        //
        // Better Auth mints a new `reset-password:<token>` row on every
        // forgot-password request but never expires the previous ones. So a
        // user who clicks "resend", or an attacker who kept an old/forwarded
        // reset email, is left holding MULTIPLE simultaneously-valid reset
        // links — any of which can change the password. (Each link is already
        // single-use: Better Auth deletes the token the instant it's consumed,
        // so reuse-after-reset was never possible. The gap is the *stale/old*
        // link that a new request should have invalidated.)
        //
        // Before a fresh reset token is written, delete every prior reset
        // token for the same user from BOTH Postgres and the Redis mirror. The
        // Redis key shape matches redisSecondaryStorage above
        // (`ba:rl:verification:<identifier>`). Net effect: requesting a new
        // link immediately invalidates all older ones.
        //
        // Fires on every verification create; the identifier guard scopes the
        // work to password-reset rows only (OAuth state / PKCE fall through).
        before: async (data: { identifier?: unknown; value?: unknown }) => {
          const identifier = data?.identifier;
          const userId = data?.value;
          if (
            typeof identifier !== "string" ||
            !identifier.startsWith("reset-password:") ||
            typeof userId !== "string" ||
            !userId
          ) {
            return;
          }
          try {
            const stale = await db
              .delete(schema.verification)
              .where(
                and(
                  eq(schema.verification.value, userId),
                  like(schema.verification.identifier, "reset-password:%"),
                ),
              )
              .returning();
            if (redis && stale.length > 0) {
              await redis
                .del(...stale.map((row) => `ba:rl:verification:${row.identifier}`))
                .catch(() => {});
            }
          } catch (err) {
            // Never block a legitimate reset because cleanup of prior tokens
            // failed — the new token is still single-use and short-lived.
            console.error("[auth] reset-token invalidation failed:", err);
          }
        },
      },
    },
    user: {
      create: {
        before: async (user: any) => {
          const deletedIdentity = user.email
            ? await getDeletedIdentity(user.email)
            : null;
          assertDeletedIdentityCanRegister(deletedIdentity);

          // OAuth signups may not have a username — generate one
          if (!user.username) {
            const generated = await generateUniqueUsername(user.name, user.email);
            return { data: { username: generated, displayUsername: generated } };
          }
        },
        after: async (user: any, ctx: any) => {
          // Re-check after INSERT. A same-email signup can start while a banned
          // deletion transaction is uncommitted, then continue after the old
          // unique email row disappears. Compensate only banned identities;
          // ordinary deleted identities may register again immediately.
          const deletedIdentity = user.email
            ? await rejectBannedDeletedIdentityAfterCreate(user.id, user.email)
            : null;
          assertDeletedIdentityCanRegister(deletedIdentity);

          // Create credit wallet immediately so new users have credits on first load.
          try {
            await ensureWallet(user.id, "free");
          } catch (err) {
            console.error(`[AUTH] Failed to create wallet for user ${user.id}:`, err);
          }

          reportSignupConversion(user, ctx);
        },
      },
      update: {
        // Better Auth's own writes (email change, verification, name/image via
        // updateUser) must drop the middleware's 60s SessionUser cache too.
        after: async (user: any) => {
          if (user?.id) await invalidateSessionUser(String(user.id));
        },
      },
    },
  },
  socialProviders: {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
        },
      }
      : {}),
    ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
        github: {
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
        },
      }
      : {}),
    ...(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET
      ? {
        discord: {
          clientId: env.DISCORD_CLIENT_ID,
          clientSecret: env.DISCORD_CLIENT_SECRET,
        },
      }
      : {}),
    ...(env.TWITTER_CLIENT_ID && env.TWITTER_CLIENT_SECRET
      ? {
        twitter: {
          clientId: env.TWITTER_CLIENT_ID,
          clientSecret: env.TWITTER_CLIENT_SECRET,
        },
      }
      : {}),
  },
});

export type Auth = typeof auth;
