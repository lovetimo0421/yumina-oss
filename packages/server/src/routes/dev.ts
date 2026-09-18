import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { makeSignature } from "better-auth/crypto";
import { auth } from "../lib/auth.js";
import { IS_DEV, env } from "../lib/env.js";
import { db } from "../db/index.js";
import { user } from "../db/schema.js";

const devRoutes = new Hono();

const DEV_EMAIL = "dev@yumina.local";
const DEV_PASSWORD = "devpassword123";
const DEV_NAME = "Dev User";
const LOCAL_GORGY_EMAIL = "localgorgy@yumina.local";

async function markEmailVerified(email: string) {
  await db
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.email, email));
}

function isLocalHelperAvailable(url: string) {
  if (IS_DEV || !env.DATABASE_URL) {
    const hostname = new URL(url).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1";
  }

  return false;
}

/**
 * POST /api/dev/auto-login
 * Creates a default dev account if it doesn't exist, then signs in.
 * Only available when NODE_ENV !== "production".
 */
devRoutes.post("/auto-login", async (c) => {
  if (!isLocalHelperAvailable(c.req.url)) {
    return c.json({ error: "Not available in production" }, 404);
  }

  try {
    // Try sign-in first
    let result = await auth.api.signInEmail({
      body: { email: DEV_EMAIL, password: DEV_PASSWORD },
    }).catch(() => null);

    if (result) {
      await markEmailVerified(DEV_EMAIL);
    }

    if (!result) {
      await markEmailVerified(DEV_EMAIL);
      result = await auth.api.signInEmail({
        body: { email: DEV_EMAIL, password: DEV_PASSWORD },
      }).catch(() => null);
    }

    if (!result) {
      // Create the account first
      await auth.api.signUpEmail({
        body: { name: DEV_NAME, email: DEV_EMAIL, password: DEV_PASSWORD },
      });
      await markEmailVerified(DEV_EMAIL);

      // Then sign in
      result = await auth.api.signInEmail({
        body: { email: DEV_EMAIL, password: DEV_PASSWORD },
      });
    }

    // Set session cookie via Better Auth's handler so the browser gets it
    const internalReq = new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD }),
    });
    const res = await auth.handler(internalReq);
    await markEmailVerified(DEV_EMAIL);

    // Forward Set-Cookie headers
    res.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") {
        c.header("Set-Cookie", value, { append: true });
      }
    });

    const data = await res.json();
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: "Auto-login failed", detail: err.message }, 500);
  }
});

/**
 * GET /api/dev/auto-login/localgorgy
 * Local-only browser helper: signs in as the seeded localgorgy account
 * and redirects back into the app so the browser receives the auth cookie.
 */
devRoutes.get("/auto-login/localgorgy", async (c) => {
  if (!isLocalHelperAvailable(c.req.url)) {
    return c.json({ error: "Not available in production" }, 404);
  }

  try {
    const redirectToRaw = c.req.query("redirect") || "/app/profile";
    const redirectTo = redirectToRaw.startsWith("/") ? redirectToRaw : "/app/profile";
    let localUser = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, LOCAL_GORGY_EMAIL))
      .limit(1);

    if (localUser.length === 0) {
      await db.insert(user).values({
        id: crypto.randomUUID(),
        name: "LocalGorgy",
        email: LOCAL_GORGY_EMAIL,
        emailVerified: true,
        username: "localgorgy",
      });

      localUser = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, LOCAL_GORGY_EMAIL))
        .limit(1);
    } else {
      await db
        .update(user)
        .set({ emailVerified: true, username: "localgorgy" })
        .where(eq(user.email, LOCAL_GORGY_EMAIL));
    }

    const localUserId = localUser[0]?.id;
    if (!localUserId) {
      return c.json({ error: "Local auto-login failed", detail: "Could not create or load localgorgy user" }, 500);
    }

    const authContext = await auth.$context;
    const createdSession = await authContext.internalAdapter.createSession(localUserId);
    const signedToken = `${createdSession.token}.${await makeSignature(createdSession.token, authContext.secret)}`;

    setCookie(c, authContext.authCookies.sessionToken.name, signedToken, {
      ...authContext.authCookies.sessionToken.attributes,
      maxAge: authContext.sessionConfig.expiresIn,
    });

    return c.redirect(redirectTo, 302);
  } catch (err: any) {
    return c.json({ error: "Local auto-login failed", detail: err.message }, 500);
  }
});

export { devRoutes };
