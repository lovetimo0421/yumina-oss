import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { corsMiddleware } from "./cors.js";

test("balance voice requires an exact explicit browser origin independently of development CORS", async () => {
  const api = await import("./cors.js") as unknown as { strictVoiceOrigin?: (origin: string | null, allowed?: ReadonlySet<string>) => boolean };
  const allowed = new Set(["https://yumina.io", "http://127.0.0.1:32123"]);
  for (const origin of ["https://yumina.io", "http://127.0.0.1:32123"])
    assert.equal(api.strictVoiceOrigin?.(origin, allowed), true);
  for (const origin of [null, "null", "", "https://yumina.io/", "https://yumina.io.evil.test", "https://evil.test", "https://user@yumina.io", "https://yumina.io?x=1", "http://localhost:32123", "https://yumina.io\n"])
    assert.equal(api.strictVoiceOrigin?.(origin, allowed), false);
});

test("voice run identity survives cross-origin preflight", async () => {
  const app = new Hono().use("*", corsMiddleware);
  const response = await app.request("/api/voice/test/stop", { method: "OPTIONS", headers: {
    Origin: "https://yumina.io", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-voice-connection-id",
  } });
  assert.match(response.headers.get("Access-Control-Allow-Headers") ?? "", /x-voice-connection-id/i);
});

test('acknowledged state save survives cross-origin PATCH preflight', async () => {
  const app = new Hono().use('*', corsMiddleware);
  const response = await app.request('/api/sessions/fixture/state', { method: 'OPTIONS', headers: {
    Origin: 'https://yumina.io', 'Access-Control-Request-Method': 'PATCH',
    'Access-Control-Request-Headers': 'content-type,x-yumina-state-acknowledgement',
  } });
  assert.match(response.headers.get('Access-Control-Allow-Headers') ?? '', /x-yumina-state-acknowledgement/i);
});
