import assert from "node:assert/strict";
import test from "node:test";
import { CustomProvider } from "./custom.js";
import { clampMaxContextToModel } from "./context-window.js";
import { PromptBuilder, estimateTokens, preloadTokenizer } from "@yumina/engine";

test("Featherless plan limits are cached per credential and constrain long chat history", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, "https://api.featherless.ai/v1/plan");
    const key = new Headers(init.headers).get("authorization");
    return Response.json({ max_context_length: key === "Bearer small-plan" ? 32768 : 65536 });
  });
  const providers = [new CustomProvider("small-plan", "https://api.featherless.ai/v1"), new CustomProvider("small-plan", "https://api.featherless.ai/v1")];
  assert.deepEqual(await Promise.all(providers.map(p => p.getContextWindow())), [32768, 32768]);
  assert.equal(calls, 1, "same account shares one in-flight plan request");
  assert.equal(await new CustomProvider("larger-plan", "https://api.featherless.ai/v1").getContextWindow(), 65536);
  assert.equal(calls, 2, "different accounts never share a plan cap");
  const budget = clampMaxContextToModel(64000, "custom/Qwen/Qwen2.5-0.5B-Instruct", 12000, undefined, 32768);
  assert.ok(budget + 12000 <= 32768);
  await preloadTokenizer();
  const history = [{ role: "system" as const, content: "Roleplay instructions." }, ...Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, content: `Turn ${i}. ` + "hello ".repeat(500) })), { role: "user" as const, content: "Latest user message" }];
  const result = await new PromptBuilder().buildMessageHistoryAsync(history, async () => {}, budget, 1, 0, "custom/Qwen/Qwen2.5-0.5B-Instruct");
  assert.ok(result.length < history.length);
  assert.equal(result[0]!.content, history[0]!.content);
  assert.equal(result.at(-1)!.content, "Latest user message");
  assert.ok(result.reduce((total, m) => total + estimateTokens(m.content), 0) + 12000 <= 32768);
  assert.equal(history.length, 102, "stored history is not mutated");
});

test("plan discovery is restricted to the real Featherless API", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  for (const url of ["https://api.example.com/v1", "https://api.featherless.ai.evil.test/v1", "https://api.featherless.ai/another/v1"]) {
    assert.equal(await new CustomProvider("other-key", url).getContextWindow(), undefined);
  }
});

test("unavailable or malformed plan discovery leaves existing provider behavior intact", async t => {
  for (const [i, response] of [new Response("Unavailable", { status: 503 }), Response.json({ max_context_length: "32768" }), Response.json({ max_context_length: -1 }), Response.json(null)].entries()) {
    t.mock.method(globalThis, "fetch", async () => response);
    assert.equal(await new CustomProvider(`bad-plan-${i}`, "https://api.featherless.ai/v1").getContextWindow(), undefined);
  }
  assert.equal(clampMaxContextToModel(64000, "custom/unknown", 12000, undefined, NaN), 64000);
});
