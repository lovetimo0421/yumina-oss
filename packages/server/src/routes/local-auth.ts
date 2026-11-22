import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { makeSignature } from "better-auth/crypto";
import { auth } from "../lib/auth.js";
import { isIP } from "node:net";
import { AUTH_MODE, env } from "../lib/env.js";

function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const hostname = new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
    return hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  } catch {
    return null;
  }
}

/**
 * True when the request was made by this install's own page: it is addressed to
 * this machine by address, by "localhost", or by the name the install was
 * configured with, and (when the browser says where the page is) the page is on
 * that same host. Ports are not compared: the dev app and the API differ there.
 */
export function isOwnPageRequest(hostHeader: string | undefined, originHeader: string | undefined): boolean {
  const host = hostnameOf(hostHeader);
  if (!host) return false;
  const configured = [hostnameOf(env.APP_URL), hostnameOf(env.BETTER_AUTH_URL)];
  if (host !== "localhost" && !isIP(host) && !configured.includes(host)) return false;
  if (originHeader === undefined) return true;
  const origin = hostnameOf(originHeader);
  return origin === host || (origin !== null && configured.includes(origin));
}
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
  // This route hands out a session with no password, so it must only answer
  // the app itself. Another site's page can post here from the same browser:
  // its Origin gives it away. And a hostile domain re-pointed at this machine
  // (DNS rebinding) arrives under its own name, which is neither an address
  // nor the name this install was set up with.
  if (!isOwnPageRequest(c.req.header("host"), c.req.header("origin"))) {
    return c.json({ error: "Not found" }, 404);
  }

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
