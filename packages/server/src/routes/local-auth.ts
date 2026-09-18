import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { makeSignature } from "better-auth/crypto";
import { auth } from "../lib/auth.js";
import { AUTH_MODE } from "../lib/env.js";
import { db } from "../db/index.js";
import { user } from "../db/schema.js";

/**
 * Single-user mode (the open-source local edition's default).
 *
 * There is exactly one account on this install and whoever can reach the
 * server owns it, the same trust model SillyTavern uses. So instead of a login
 * screen the client calls POST /api/local-auth/sign-in once and receives a
 * normal Better Auth session cookie for the local account. Everything after
 * that is the ordinary authenticated code path: sessions, keys, worlds all
 * hang off a real user row.
 *
 * Hard gate: the router 404s unless YUMINA_AUTH_MODE resolves to single-user.
 * The hosted edition never exposes this. The server also binds 127.0.0.1 by
 * default in the local edition (env.HOST), which is the second half of the
 * "reachable == owner" assumption; SECURITY.md spells this out.
 */
export const LOCAL_ACCOUNT_EMAIL = "local@yumina.local";
const LOCAL_ACCOUNT_NAME = "Local player";
const LOCAL_ACCOUNT_USERNAME = "local";

export const localAuthRoutes = new Hono();

async function ensureLocalUser(): Promise<string> {
  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, LOCAL_ACCOUNT_EMAIL))
    .limit(1);
  if (existing[0]?.id) return existing[0].id;

  const id = crypto.randomUUID();
  await db.insert(user).values({
    id,
    name: LOCAL_ACCOUNT_NAME,
    email: LOCAL_ACCOUNT_EMAIL,
    emailVerified: true,
    username: LOCAL_ACCOUNT_USERNAME,
  });
  return id;
}

localAuthRoutes.get("/", (c) => {
  if (AUTH_MODE !== "single-user") return c.json({ error: "Not found" }, 404);
  return c.json({ data: { mode: AUTH_MODE, email: LOCAL_ACCOUNT_EMAIL } });
});

localAuthRoutes.post("/sign-in", async (c) => {
  if (AUTH_MODE !== "single-user") return c.json({ error: "Not found" }, 404);

  try {
    const userId = await ensureLocalUser();
    const authContext = await auth.$context;
    const created = await authContext.internalAdapter.createSession(userId);
    const signed = `${created.token}.${await makeSignature(created.token, authContext.secret)}`;

    setCookie(c, authContext.authCookies.sessionToken.name, signed, {
      ...authContext.authCookies.sessionToken.attributes,
      maxAge: authContext.sessionConfig.expiresIn,
    });
    c.header("Cache-Control", "no-store");
    return c.json({ data: { userId } });
  } catch (err) {
    console.error("[local-auth] sign-in failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "Local sign-in failed" }, 500);
  }
});
