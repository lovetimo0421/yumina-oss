import { test } from "node:test";
import assert from "node:assert/strict";
import { CustomProvider } from "./custom.js";
import { customEndpointFailure, verifyCustomConnection } from "./custom-connection.js";

test("verification uses the manually saved model with an empty discovered list", async (t) => {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit) => {
    paths.push(new URL(String(input)).pathname);
    if (String(input).endsWith("/models")) return new Response("Gone.", { status: 404 });
    assert.equal(JSON.parse(String(init.body)).model, "owner/working-model");
    return Response.json({ choices: [{ message: { content: "Hello" } }] });
  });
  const result = await verifyCustomConnection(new CustomProvider("key", "https://api.featherless.ai/v1"), {
    models: [], defaultModel: "owner/working-model",
  });
  assert.equal(result.valid, true);
  assert.equal(result.modelVerified, true);
  assert.deepEqual(paths, ["/v1/chat/completions"]);
});

test("a discoverable model is not claimed to have passed generation", async () => {
  const result = await verifyCustomConnection({
    listModelsDetailed: async () => ({ ok: true, models: ["owner/model"] }),
    sendTestMessage: async () => { throw new Error("Do not generate just to fetch models"); },
  });
  assert.equal(result.valid, true);
  assert.equal(result.modelVerified, false);
});

test("discovery cannot hide a failed test of the selected model", async () => {
  const result = await verifyCustomConnection({
    listModelsDetailed: async () => ({ ok: true, models: ["owner/model"] }),
    sendTestMessage: async () => ({ ok: false, status: 403 }),
  }, { defaultModel: "owner/model" });
  assert.equal(result.valid, false);
  assert.equal(result.code, "access_denied");
});

test("404 model discovery suggests manual entry without misdiagnosing the key or /v1", async () => {
  const result = await verifyCustomConnection({
    listModelsDetailed: async () => ({ ok: false, status: 404, models: [], reason: "Gone." }),
    sendTestMessage: async () => { throw new Error("No known model; no paid probe"); },
  }, { models: [] });
  assert.equal(result.valid, false);
  assert.equal(result.code, "model_list_unavailable");
  assert.match(result.reason!, /model ID/);
  assert.doesNotMatch(result.reason!, /Invalid API key|adding \/v1/);
});

test("distinguishes denied access and rate limits from invalid authentication", () => {
  assert.equal(customEndpointFailure("models", 401).code, "authentication_failed");
  assert.equal(customEndpointFailure("models", 403).code, "access_denied");
  assert.equal(customEndpointFailure("models", 429).code, "rate_limited");
  assert.equal(customEndpointFailure("chat", 404).code, "model_test_failed");
  assert.match(customEndpointFailure("chat", 404).reason, /model/);
});
