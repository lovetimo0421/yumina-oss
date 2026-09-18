import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { privateStateCache } from "./private-state-cache.js";

for (const path of [
  "/api/admin/insights/finance", "/api/admin/moderation", "/api/referrals/me",
  "/api/invite-codes/welcome", "/api/invite-codes/redeem", "/api/tips/giftable-balance",
  "/api/check-ins/status", "/api/check-ins/claim", "/api/subscription/status",
  "/api/users/me", "/api/users/me/ai-config", "/api/keys", "/api/models",
  "/api/sessions", "/api/sessions/session", "/api/sessions/session/messages",
]) {
  test(`personal state at ${path} cannot be stored by browsers or a CDN`, async () => {
    const app = new Hono();
    app.use("/api/*", privateStateCache);
    app.get(path, (c) => c.json({ data: "current account state" }));
    const res = await app.request(path);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.equal(res.headers.get("cdn-cache-control"), "no-store");
  });
}

test("public feeds keep their cache policy", async () => {
  const app = new Hono();
  app.use("/api/*", privateStateCache);
  app.get("/api/worlds/hub", (c) => {
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ data: [] });
  });
  const res = await app.request("/api/worlds/hub");
  assert.equal(res.headers.get("cache-control"), "public, max-age=60");
  assert.equal(res.headers.get("cdn-cache-control"), null);
});

test("authentication failures and writes have the same private-state cache policy", async () => {
  const app = new Hono();
  app.use("/api/*", privateStateCache);
  app.get("/api/users/me", (c) => c.json({ error: "Unauthorized" }, 401));
  app.patch("/api/users/me", (c) => c.json({ data: { preferences: { preferredProvider: "private" } } }));
  for (const method of ["GET", "PATCH"]) {
    const res = await app.request("/api/users/me", { method });
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  }
});

test("message streams retain their no-transform policy", async () => {
  const app = new Hono();
  app.use("/api/*", privateStateCache);
  app.post("/api/sessions/session/messages", (c) => {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache, no-transform");
    return c.body("data: done\n\n");
  });
  const res = await app.request("/api/sessions/session/messages", { method: "POST" });
  assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
});
