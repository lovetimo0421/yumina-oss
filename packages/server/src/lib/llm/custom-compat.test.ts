import { test } from "node:test";
import assert from "node:assert/strict";
import { CustomProvider } from "./custom.js";
import type { GenerateParams, StreamChunk } from "./types.js";

const OPEN_CODE = "https://opencode.ai/zen/go/v1";
const params: GenerateParams = {
  model: "custom/longcat-2.0",
  messages: [{ role: "user", content: "Hi" }],
  conversationId: "play:conversation-a",
};
const chatResponse = () => Response.json({ choices: [{ message: { content: "Hello" } }] });
const streamResponse = () => new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n');
async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("OpenCode replaces static/placeholder headers and keeps identity across provider instances and modes", async (t) => {
  const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ headers: new Headers(init.headers), body });
    return body.stream ? streamResponse() : chatResponse();
  });
  const metadata = { includeHeaders: {
    "X-OpenCode-Session": "<stable-id-per-conversation>",
    "x-opencode-session": "shared-by-all-chats",
    "user-agent": "Node fetch",
    "X-Custom": "preserved",
  } };
  for (const stream of [true, false, true]) {
    await collect(new CustomProvider("key", OPEN_CODE, metadata).generateStream({ ...params, stream }));
  }
  await collect(new CustomProvider("key", OPEN_CODE).generateStream({ ...params, conversationId: "play:conversation-b" }));
  const ids = requests.map(r => r.headers.get("x-opencode-session"));
  assert.match(ids[0]!, /^[a-f0-9]{64}$/);
  assert.equal(new Set(ids.slice(0, 3)).size, 1);
  assert.notEqual(ids[0], ids[3]);
  assert.match(requests[0]!.headers.get("user-agent")!, /^Yumina/);
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer key");
  assert.equal(requests[0]!.headers.get("x-custom"), "preserved");
  assert.equal("conversationId" in requests[0]!.body, false);
  assert.equal(metadata.includeHeaders["x-opencode-session"], "shared-by-all-chats");
});

test("OpenCode preserves identity through unsupported-parameter and upstream retries", async (t) => {
  const ids: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    ids.push(new Headers(init.headers).get("x-opencode-session"));
    if (ids.length === 1) return new Response('{"error":{"message":"Unsupported parameter: temperature"}}', { status: 400 });
    if (ids.length === 2) return new Response("Temporarily unavailable", { status: 503 });
    return streamResponse();
  });
  const chunks = await collect(new CustomProvider("key", OPEN_CODE).generateStream({ ...params, temperature: 0.5 }));
  assert.equal(chunks.some(c => c.type === "text"), true);
  assert.equal(ids.length, 3);
  assert.ok(ids[0]);
  assert.equal(new Set(ids).size, 1);
});

test("OpenCode standalone tests and discovery have IDs, separate from each other", async (t) => {
  const ids: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit) => {
    ids.push(new Headers(init.headers).get("x-opencode-session"));
    return String(input).endsWith("/models") ? Response.json({ data: [{ id: "longcat-2.0" }] }) : chatResponse();
  });
  const provider = new CustomProvider("key", OPEN_CODE);
  await provider.listModels();
  await provider.listModelsDetailed();
  await provider.verify();
  await provider.sendTestMessage("longcat-2.0");
  await provider.sendTestMessage("longcat-2.0");
  assert.ok(ids.every(id => id && /^[a-f0-9]{64}$/.test(id)));
  assert.equal(new Set(ids).size, ids.length);
});

test("standalone generation allocates once across retries, but not across separate calls", async (t) => {
  const ids: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    ids.push(new Headers(init.headers).get("x-opencode-session"));
    return ids.length === 1 ? new Response("busy", { status: 503 }) : streamResponse();
  });
  const provider = new CustomProvider("key", OPEN_CODE);
  await collect(provider.generateStream({ ...params, conversationId: undefined }));
  await collect(provider.generateStream({ ...params, conversationId: undefined }));
  assert.ok(ids[0]);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[1], ids[2]);
});

test("concurrent conversations cannot overwrite each other's header", async (t) => {
  const ids = new Map<string, string | null>();
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    ids.set(JSON.parse(String(init.body)).messages[0].content, new Headers(init.headers).get("x-opencode-session"));
    await new Promise(resolve => setTimeout(resolve, 5));
    return streamResponse();
  });
  const provider = new CustomProvider("key", OPEN_CODE);
  await Promise.all(["a", "b"].map(id => collect(provider.generateStream({ ...params, conversationId: `play:${id}`, messages: [{ role: "user", content: id }] }))));
  assert.ok(ids.get("a"));
  assert.notEqual(ids.get("a"), ids.get("b"));
});

test("the regular OpenCode Zen endpoint uses the same automatic identity support", async (t) => {
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    assert.match(new Headers(init.headers).get("x-opencode-session")!, /^[a-f0-9]{64}$/);
    return streamResponse();
  });
  await collect(new CustomProvider("key", "https://opencode.ai/zen/v1/").generateStream(params));
});

test("model test parameter fallback retains the standalone OpenCode session", async (t) => {
  const ids: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    ids.push(new Headers(init.headers).get("x-opencode-session"));
    return ids.length === 1
      ? new Response('{"error":{"message":"Unsupported parameter: temperature"}}', { status: 400 })
      : chatResponse();
  });
  const result = await new CustomProvider("key", OPEN_CODE, { includeBody: { temperature: 1 } }).sendTestMessage("longcat-2.0");
  assert.equal(result.ok, true);
  assert.equal(ids.length, 2);
  assert.ok(ids[0]);
  assert.equal(ids[0], ids[1]);
});

for (const endpoint of ["https://api.featherless.ai/v1", "https://opencode.ai.example.com/zen/go/v1", "https://opencode.ai/unrelated/v1"]) {
  test(`does not inject OpenCode identity into ${endpoint}`, async (t) => {
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.has("x-opencode-session"), false);
      assert.equal(headers.has("user-agent"), false);
      return streamResponse();
    });
    await collect(new CustomProvider("key", endpoint).generateStream(params));
  });
}

test("Featherless model discovery failure does not prevent a direct model test", async (t) => {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit) => {
    paths.push(new URL(String(input)).pathname);
    if (String(input).endsWith("/models")) return new Response("Gone.", { status: 404 });
    assert.equal(JSON.parse(String(init.body)).model, "owner/working-model");
    return chatResponse();
  });
  const provider = new CustomProvider("key", "https://api.featherless.ai/v1");
  assert.equal((await provider.listModelsDetailed()).status, 404);
  const result = await provider.sendTestMessage("custom/owner/working-model");
  assert.equal(result.ok, true);
  assert.equal(result.reply, "Hello");
  assert.deepEqual(paths, ["/v1/models", "/v1/chat/completions"]);
});

for (const body of ["<html>Welcome</html>", "{}", '{"error":{"message":"invalid model"}}', '{"choices":[{"message":{"content":""}}]}', '{"choices":[{"message":{"content":"   "}}]}']) {
  test(`a 200 response without a real assistant reply is not a successful test: ${body}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(body));
    assert.equal((await new CustomProvider("key", "https://api.featherless.ai/v1").sendTestMessage("owner/model")).ok, false);
  });
}
