import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { MAX_REQUEST_BODY_BYTES, MAX_WORLD_SAVE_BODY_BYTES } from "@yumina/shared";
import { requestBodyLimit, requestBodyLimitBytes } from "./request-body-limit.js";

const MiB = 1024 * 1024;
function app() {
  const server = new Hono();
  server.use("/api/*", requestBodyLimit);
  server.all("*", async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
  return server;
}

test("only world creation and update receive the larger budget", () => {
  for (const [method, path] of [["POST", "/api/worlds"], ["POST", "/api/worlds/"], ["PATCH", "/api/worlds/id"], ["PATCH", "/api/worlds/id/"]]) {
    assert.equal(requestBodyLimitBytes(method!, path!), MAX_WORLD_SAVE_BODY_BYTES);
  }
  for (const [method, path] of [["POST", "/api/worlds/id/publish"], ["POST", "/api/worlds/id"], ["PATCH", "/api/worlds"], ["PATCH", "/api/worlds/id/translations"], ["POST", "/api/messages"], ["PUT", "/api/worlds/id"]]) {
    assert.equal(requestBodyLimitBytes(method!, path!), MAX_REQUEST_BODY_BYTES);
  }
});

for (const [method, path, limit] of [["POST", "/api/worlds", 10 * MiB], ["PATCH", "/api/worlds/id", 10 * MiB], ["POST", "/api/messages", 5 * MiB]] as const) {
  test(`${method} ${path} accepts the exact limit and rejects one extra byte, with or without a declared length`, async () => {
    for (const declared of [false, true]) {
      for (const extra of [0, 1]) {
        const bytes = limit + extra;
        const response = await app().request(path, {
          method, body: new Uint8Array(bytes),
          headers: declared ? { "content-length": String(bytes) } : {},
        });
        assert.equal(response.status, extra ? 413 : 200);
        assert.deepEqual(await response.json(), extra
          ? { error: `Request body too large (max ${limit / MiB} MB)` }
          : { bytes });
      }
    }
  });
}

test("world JSON between 5 and 10 MiB reaches the parser intact", async () => {
  const server = new Hono();
  server.use("/api/*", requestBodyLimit);
  server.patch("/api/worlds/:id", async (c) => c.json(await c.req.json()));
  const payload = { schema: { source: "汉".repeat(2 * MiB) } };
  const response = await server.request("/api/worlds/id", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), payload);
});

test("an understated Content-Length cannot bypass actual byte counting", async () => {
  const response = await app().request("/api/worlds", {
    method: "POST", headers: { "content-length": "1" }, body: new Uint8Array(10 * MiB + 1),
  });
  assert.equal(response.status, 413);
});

test("chunked requests stop and cancel at the limit without entering a handler", async () => {
  let pulled = 0;
  let cancelled = false;
  let handled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(MiB)); },
    cancel() { cancelled = true; },
  });
  const server = new Hono();
  server.use("*", requestBodyLimit);
  server.post("*", (c) => { handled = true; return c.text("unexpected"); });
  const init = { method: "POST", body: stream, duplex: "half" as const, headers: { "transfer-encoding": "chunked" } };
  const response = await server.request(new Request("http://localhost/api/worlds", init));
  assert.equal(response.status, 413);
  assert.equal(handled, false);
  assert.equal(cancelled, true);
  assert.ok(pulled <= 12, `unexpected read-ahead: ${pulled} MiB`);
});

test("Stripe retains its raw body exemption and bodyless requests pass", async () => {
  const response = await app().request("/api/stripe/webhook", { method: "POST", body: new Uint8Array(6 * MiB) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { bytes: 6 * MiB });
  assert.equal((await app().request("/api/worlds")).status, 200);
});

test("the production Node adapter preserves accepted bodies and returns 413 for chunked overflow", async () => {
  const server = serve({ fetch: app().fetch, port: 0, hostname: "127.0.0.1" });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/api/worlds`;
    const accepted = await fetch(url, { method: "POST", body: new Uint8Array(6 * MiB) });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { bytes: 6 * MiB });

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 11; i++) controller.enqueue(new Uint8Array(MiB));
        controller.close();
      },
    });
    const rejected = await fetch(url, { method: "POST", body: oversized, duplex: "half" });
    assert.equal(rejected.status, 413);
    assert.deepEqual(await rejected.json(), { error: "Request body too large (max 10 MB)" });
  } finally {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
