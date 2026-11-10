import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { env } from "../lib/env.js";

test("the local runner uses an ephemeral database and does not load dotenv credentials", () => {
  assert.equal(process.env.YUMINA_LOCAL_TEST, "1");
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.DATABASE_READ_URL, "");
  assert.equal(env.PGLITE_DATA_DIR, "memory://");
  assert.equal(env.REDIS_URL, "");
  assert.equal(env.POSTHOG_API_KEY, "");
  assert.equal(env.YUMINA_OPENROUTER_KEY, "");
  assert.equal(env.STRIPE_SECRET_KEY, "");
  assert.equal(env.AWS_ACCESS_KEY_ID, "");
  const require = createRequire(import.meta.url);
  assert.deepEqual(require("dotenv").config({ path: "intentionally-not-an-env-file" }), { parsed: {} });
});

test("external fetches require a mock, while a loopback HTTP test server remains usable", async () => {
  await assert.rejects(fetch("https://external.invalid/test"), /refuse an unmocked external request/);
  const server = createServer((_req, res) => res.end("local fixture"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(await response.text(), "local fixture");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
