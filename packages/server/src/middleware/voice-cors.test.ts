import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { corsMiddleware } from "./cors.js";

test("voice run identity survives cross-origin preflight", async () => {
  const app = new Hono().use("*", corsMiddleware);
  const response = await app.request("/api/voice/test/stop", { method: "OPTIONS", headers: {
    Origin: "https://yumina.io", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-voice-connection-id",
  } });
  assert.match(response.headers.get("Access-Control-Allow-Headers") ?? "", /x-voice-connection-id/i);
});
