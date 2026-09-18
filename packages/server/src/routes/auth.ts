import { Hono, type Context } from "hono";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { auth } from "../lib/auth.js";
import { db } from "../db/index.js";
import { user, verification } from "../db/schema.js";
import { redis } from "../lib/redis.js";
import { turnstileMiddleware } from "../middleware/turnstile.js";
import { ipRateLimitMiddleware, checkPasswordResetRateLimit } from "../middleware/rate-limit.js";
import { getSessionToken } from "../middleware/auth.js";
import {
  AccountDeletionBlockedError,
  assertAccountDeletionAllowed,
  type AccountDeletionBlockCode,
  InvalidAccountDeletionTokenError,
  permanentlyDeleteAccount,
} from "../lib/account-deletion.js";
import { evaluateAccountDeletionAccess } from "../lib/account-deletion-access.js";
import { buildAccountDeletionConfirmationUrl } from "../lib/account-deletion-link.js";
import {
  deleteAccountEmailHtml,
  deleteAccountEmailSubject,
  deleteAccountEmailText,
  sendEmail,
} from "../lib/email.js";
import { env } from "../lib/env.js";

const authRoutes = new Hono();

const ACCOUNT_DELETION_ORIGINS = new Set(
  [
    env.APP_URL,
    env.BETTER_AUTH_URL,
    "https://yumina.io",
    "https://www.yumina.io",
    "https://creator.yumina.io",
  ].map((value) => new URL(value).origin),
);

function validateAccountDeletionMutation(request: Request): string | null {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) return "Content-Type must be application/json";

  const source = request.headers.get("origin") ?? request.headers.get("referer");
  if (!source) return "Missing request origin";
  try {
    if (!ACCOUNT_DELETION_ORIGINS.has(new URL(source).origin)) return "Untrusted request origin";
  } catch {
    return "Invalid request origin";
  }
  return null;
}

function clearAccountCookies(c: Context): void {
  const hostname = new URL(env.APP_URL).hostname.toLowerCase();
  const domain = hostname === "yumina.io" || hostname.endsWith(".yumina.io")
    ? "; Domain=.yumina.io"
    : "";
  for (const name of [
    "yumina.session_token",
    "__Secure-yumina.session_token",
    "yumina.session_data",
    "__Secure-yumina.session_data",
  ]) {
    c.header(
      "Set-Cookie",
      `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax; Secure${domain}`,
      { append: true },
    );
  }
}

function accountDeletionBlockedStatus(
  code: AccountDeletionBlockCode,
): 403 | 409 | 503 {
  if (code === "ACCOUNT_DELETION_NOT_READY") return 503;
  return 409;
}

function isAccountDeletionToken(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{48}$/.test(value);
}

// IP-based rate limiting on auth mutations only (POST = login, signup, password reset).
// GET requests (session checks, OAuth callbacks) are excluded — the browser checks
// the session on every page load and those shouldn't count toward the limit.
// 40/60s (relaxed from 10, then 20) gives shared-IP / NAT users headroom; the real
// brute-force defense is per-account (middleware/turnstile.ts step-up).
// /is-username-available and /sign-out are exempt from the shared bucket: the
// register page fires availability checks on every typing pause and the login
// page fires a sign-out before every OAuth attempt — one signup flow costs 4-9
// bucket units otherwise, locking out NAT neighbours. Better Auth's own
// per-IP-per-path limiter still covers both.
const authIpLimit = ipRateLimitMiddleware(40, 60);
authRoutes.on("POST", "/*", (c, next) => {
  const path = c.req.path.replace(/^\/api\/auth/, "");
  if (path === "/is-username-available" || path === "/sign-out") return next();
  return authIpLimit(c, next);
});

// Turnstile CAPTCHA verification on auth POST endpoints (signup, login, password reset).
// Skips automatically if TURNSTILE_SECRET_KEY is not configured.
authRoutes.use("/*", turnstileMiddleware);

// Invalidate Redis session cache on sign-out. Better Auth deletes the session
// from Postgres but doesn't know about our Redis layer. Without this, the
// stale cache entry lets the old token pass auth for up to 5 minutes.
// NOTE: no c.header() call — avoids Response cloning that drops Set-Cookie.
authRoutes.post("/sign-out", async (c, next) => {
  const token = getSessionToken(c.req.raw.headers);
  await next();
  if (token && redis) {
    // Delete both the current key (session-v2:) and the legacy key (session:)
    // for a short post-deploy window — old entries from before 2026-05-20 still
    // linger under the legacy prefix until their own TTL expires.
    redis.del(`session-v2:${token}`, `session:${token}`).catch(() => {});
  }
});

// Account deletion has a deliberately stronger confirmation contract than the
// generic Better Auth endpoint. The client must submit the signed-in user's
// exact username (or email when no username exists), and the server performs a
// payout/billing preflight before sending the final confirmation email.
authRoutes.post("/delete-user", async (c) => {
  const mutationError = validateAccountDeletionMutation(c.req.raw);
  if (mutationError) {
    return c.json({ error: mutationError, code: "INVALID_REQUEST_ORIGIN" }, 403);
  }

  let body: { confirmation?: unknown; token?: unknown; locale?: unknown };
  try {
    body = await c.req.raw.clone().json() as {
      confirmation?: unknown;
      token?: unknown;
      locale?: unknown;
    };
  } catch {
    return c.json({ error: "Invalid request body", code: "INVALID_REQUEST" }, 400);
  }

  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
    query: { disableCookieCache: true },
  });
  if (!session) {
    return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
  }

  const authUser = session.user;
  const [currentAccount] = await db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.username,
    })
    .from(user)
    .where(eq(user.id, authUser.id))
    .limit(1);
  if (!currentAccount) {
    return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
  }
  const expected = currentAccount.username?.trim() || currentAccount.email.trim();
  const confirmation = typeof body.confirmation === "string"
    ? body.confirmation.trim()
    : "";

  if (!expected || confirmation !== expected) {
    return c.json(
      { error: "Account confirmation does not match", code: "CONFIRMATION_MISMATCH" },
      400,
    );
  }

  try {
    await assertAccountDeletionAllowed(authUser.id);
  } catch (error) {
    if (error instanceof AccountDeletionBlockedError) {
      return c.json(
        { error: error.message, code: error.code },
        accountDeletionBlockedStatus(error.code),
      );
    }
    console.error(`[auth] Account deletion preflight failed for ${authUser.id}:`, error);
    return c.json(
      { error: "Account deletion is temporarily unavailable", code: "ACCOUNT_DELETION_FAILED" },
      500,
    );
  }

  if (body.token === undefined || body.token === null || body.token === "") {
    // Better Auth intentionally swallows errors thrown by its email callback.
    // Generate and persist the token here so a failed Resend call can be
    // reported honestly instead of claiming that an email was sent.
    const token = randomBytes(24).toString("hex");
    const identifier = `delete-account-${token}`;
    const emailAccount = await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT id, email, name, username, role, is_banned, is_suspended
        FROM "user"
        WHERE id = ${authUser.id} OR role = 'admin'
        ORDER BY id
        FOR UPDATE
      `);
      const lockedAccounts = locked.rows as Array<{
        id?: string;
        email?: string;
        name?: string;
        username?: string | null;
        role?: string;
        is_banned?: boolean;
        is_suspended?: boolean;
      }>;
      const account = lockedAccounts.find((row) => row.id === authUser.id);
      const access = evaluateAccountDeletionAccess(
        account?.role,
        lockedAccounts.filter(
          (candidate) => candidate.role === "admin"
            && candidate.is_banned !== true
            && candidate.is_suspended !== true,
        ).length,
      );
      if (!access.allowed) return { kind: "blocked" as const, access };
      if (!account?.id || !account.email || !account.name) {
        return { kind: "missing" as const };
      }
      const lockedExpected = account.username?.trim() || account.email.trim();
      if (confirmation !== lockedExpected) return { kind: "mismatch" as const };

      await tx.insert(verification).values({
        id: randomUUID(),
        identifier,
        value: authUser.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      return {
        kind: "account" as const,
        email: account.email,
        name: account.name,
      };
    });
    if (emailAccount.kind === "missing") {
      return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
    }
    if (emailAccount.kind === "blocked") {
      return c.json(
        { error: emailAccount.access.message, code: emailAccount.access.code },
        accountDeletionBlockedStatus(emailAccount.access.code),
      );
    }
    if (emailAccount.kind === "mismatch") {
      return c.json({ error: "Account confirmation does not match", code: "CONFIRMATION_MISMATCH" }, 400);
    }

    const url = buildAccountDeletionConfirmationUrl(env.APP_URL, token);
    if (process.env.NODE_ENV !== "production") {
      console.log(`[auth] Account deletion link for ${emailAccount.email}:\n${url}\n`);
    }

    const delivered = await sendEmail({
      to: emailAccount.email,
      subject: deleteAccountEmailSubject(
        typeof body.locale === "string" ? body.locale : undefined,
      ),
      html: deleteAccountEmailHtml(
        url,
        emailAccount.name,
        typeof body.locale === "string" ? body.locale : undefined,
      ),
      text: deleteAccountEmailText(
        url,
        emailAccount.name,
        typeof body.locale === "string" ? body.locale : undefined,
      ),
    });
    if (!delivered) {
      await db.delete(verification).where(eq(verification.identifier, identifier));
      return c.json(
        { error: "The confirmation email could not be sent", code: "DELETE_CONFIRMATION_EMAIL_FAILED" },
        503,
      );
    }

    return c.json({ success: true, message: "Verification email sent" });
  }
  if (!isAccountDeletionToken(body.token)) {
    return c.json({ error: "Invalid token", code: "INVALID_DELETE_TOKEN" }, 400);
  }

  try {
    await permanentlyDeleteAccount(authUser.id, {
      verificationIdentifier: `delete-account-${body.token}`,
    });
  } catch (error) {
    if (error instanceof InvalidAccountDeletionTokenError) {
      return c.json({ error: error.message, code: "INVALID_DELETE_TOKEN" }, 400);
    }
    if (error instanceof AccountDeletionBlockedError) {
      return c.json(
        { error: error.message, code: error.code },
        accountDeletionBlockedStatus(error.code),
      );
    }
    console.error(`[auth] Account deletion failed for ${authUser.id}:`, error);
    return c.json(
      { error: "Account deletion failed. Try again later or contact support.", code: "ACCOUNT_DELETION_FAILED" },
      500,
    );
  }

  clearAccountCookies(c);
  return c.json({ success: true, message: "Account deleted" });
});

authRoutes.post("/delete-user/cancel", async (c) => {
  const mutationError = validateAccountDeletionMutation(c.req.raw);
  if (mutationError) {
    return c.json({ error: mutationError, code: "INVALID_REQUEST_ORIGIN" }, 403);
  }
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
    query: { disableCookieCache: true },
  });
  if (!session) {
    return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
  }
  const body = await c.req
    .json<{ token?: unknown }>()
    .catch(() => ({} as { token?: unknown }));
  if (!isAccountDeletionToken(body.token)) {
    return c.json({ error: "Invalid token", code: "INVALID_TOKEN" }, 400);
  }

  const canceled = await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT id FROM "user" WHERE id = ${session.user.id} FOR UPDATE
    `);
    const account = locked.rows[0] as { id?: string } | undefined;
    if (!account?.id) return "missing" as const;
    await tx
      .delete(verification)
      .where(and(
        eq(verification.value, session.user.id),
        sql`${verification.identifier} LIKE 'delete-account-%'`,
      ));
    return "canceled" as const;
  });
  if (canceled === "missing") {
    return c.json({ error: "Account deletion has already started", code: "DELETE_ALREADY_STARTED" }, 409);
  }
  return c.json({ success: true });
});

// Better Auth exposes a destructive GET callback for its stock email flow.
// Yumina uses a safe landing page followed by an explicit POST, so do not let
// link scanners (or copied callback URLs) bypass that final confirmation.
authRoutes.get("/delete-user/callback", (c) => {
  return c.json(
    { error: "Use the account deletion confirmation page", code: "METHOD_NOT_ALLOWED" },
    405,
  );
});

// Forgot-password: apply a NAT-safe, per-EMAIL rate limit BEFORE delegating to
// Better Auth. Keyed on the email rather than the IP, so it stops someone
// bombing a victim's inbox with reset mail without penalizing VPN / shared-IP
// users. The per-IP ceiling for this endpoint is set generously in lib/auth.ts
// customRules. The email is read from a CLONE so the original body stream stays
// intact for auth.handler; a malformed/absent body falls through to Better
// Auth's own 400.
authRoutes.post("/request-password-reset", async (c) => {
  let email = "";
  try {
    const body = (await c.req.raw.clone().json()) as { email?: unknown };
    if (typeof body.email === "string") email = body.email;
  } catch {
    // Let Better Auth handle malformed bodies.
  }

  const limited = await checkPasswordResetRateLimit(email);
  if (limited) {
    c.header("Retry-After", String(limited.retryAfter));
    return c.json({ error: limited.error, code: limited.code }, 429);
  }

  return auth.handler(c.req.raw);
});

// Better Auth handles all auth routes under /api/auth/*
// IMPORTANT: return the raw Response directly — do NOT add middleware that
// calls c.header() after await next(), because Hono's Response cloning can
// lose Set-Cookie headers (the cookie that keeps users logged in).
authRoutes.all("/*", (c) => {
  return auth.handler(c.req.raw);
});

export { authRoutes };
