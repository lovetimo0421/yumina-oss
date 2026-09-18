import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

const SOURCE = readFileSync(
  fileURLToPath(new URL("./routes/messages.ts", import.meta.url)),
  "utf8",
);

const AUTH_SCOPES = [
  ...SOURCE.matchAll(
    /messageRoutes\.use\(\s*["']([^"']+)["']\s*,\s*authMiddleware\s*\)/g,
  ),
].map((match) => match[1]!);

function isCoveredByAuthScope(path: string): boolean {
  return AUTH_SCOPES.some((scope) => (
    scope.endsWith("/*") ? path.startsWith(scope.slice(0, -1)) : path === scope
  ));
}

test("message authentication stays scoped to message routes", () => {
  assert.ok(AUTH_SCOPES.length > 0, "message routes have no auth middleware");
  assert.ok(
    !AUTH_SCOPES.includes("/*"),
    "a broad /* middleware leaks onto every /api route mounted after messageRoutes",
  );
});

test("every message endpoint remains covered by an auth scope", () => {
  const routePattern = /messageRoutes\.(?:get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;
  const paths = [...SOURCE.matchAll(routePattern)].map((match) => match[1]!);

  assert.ok(paths.length > 0, "no message routes found");
  for (const path of paths) {
    assert.ok(isCoveredByAuthScope(path), `${path} is not covered by a message auth scope`);
  }
});

test("Hono does not run message authentication for a later notification mount", async () => {
  let authCalls = 0;
  const app = new Hono();
  const messages = new Hono();
  const notifications = new Hono();

  for (const scope of AUTH_SCOPES) {
    messages.use(scope, async (_context, next) => {
      authCalls += 1;
      await next();
    });
  }
  messages.get("/messages/:id", (context) => context.text("message"));
  notifications.get("/", (context) => context.text("notification"));

  app.route("/api", messages);
  app.route("/api/notifications", notifications);

  const notificationResponse = await app.request("/api/notifications");
  assert.equal(notificationResponse.status, 200);
  assert.equal(authCalls, 0);

  const messageResponse = await app.request("/api/messages/example");
  assert.equal(messageResponse.status, 200);
  assert.equal(authCalls, 1);
});
