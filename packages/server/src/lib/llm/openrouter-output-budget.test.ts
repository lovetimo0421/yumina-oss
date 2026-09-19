import assert from "node:assert/strict";
import test from "node:test";
import { OpenRouterProvider } from "./openrouter.js";
import { clampMaxContextToModel } from "./context-window.js";
import type { StreamChunk } from "./types.js";

for (const stream of [true, false]) {
  test(`Lunaris ${stream ? "streaming" : "non-streaming"} requests send the same capped output budget reserved by context trimming`, async (t) => {
    const bodies: Array<{ max_tokens: number; stream: boolean }> = [];
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.stream) {
        return new Response('data: {"choices":[{"delta":{"content":"The story continues."}}]}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n', { headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({ choices: [{ message: { content: "The story continues." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    });
    const model = "sao10k/l3-lunaris-8b";
    const chunks: StreamChunk[] = [];
    for await (const chunk of new OpenRouterProvider("test-only").generateStream({
      model, stream, maxTokens: 16_384, reasoningEffort: "high", singleAttempt: true,
      messages: [{ role: "user", content: "Continue." }],
    })) chunks.push(chunk);

    assert.deepEqual(chunks.filter(chunk => chunk.type === "error"), []);
    assert.equal(chunks.filter(chunk => chunk.type === "text").map(chunk => chunk.content).join(""), "The story continues.");
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.stream, stream);
    assert.equal(bodies[0]!.max_tokens, 4096);
    const inputBudget = clampMaxContextToModel(200_000, model, 16_384, "high");
    assert.ok(inputBudget + bodies[0]!.max_tokens <= 8192, "actual request output plus reserved input must fit the model window");
  });
}
