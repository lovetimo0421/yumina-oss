import assert from "node:assert/strict";
import test from "node:test";
import { OpenRouterProvider } from "./openrouter.js";
import type { GenerateParams, StreamChunk } from "./types.js";

for (const stream of [true, false]) {
  test(`LongCat adapts shared sampling settings before its ${stream ? "streaming" : "nonstreaming"} request`, async t => {
    const requests: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      if (body.temperature > 1 || body.top_k > 100) return Response.json({ error: { code: 400, message: "bad request", metadata: { provider_name: "AtlasCloud" } } }, { status: 400 });
      return stream
        ? new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n')
        : Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
    });
    const params: GenerateParams = {
      model: "meituan/longcat-2.0", messages: [{ role: "user", content: "Reply only OK." }],
      temperature: 1.1, topK: 200, topP: 0.95, minP: 0.16, frequencyPenalty: 0.55,
      presencePenalty: 0.35, reasoningEffort: "high", maxTokens: 12000, stream, singleAttempt: true,
    };
    const chunks: StreamChunk[] = [];
    for await (const chunk of new OpenRouterProvider("test-key").generateStream(params)) chunks.push(chunk);
    assert.equal(chunks.some(c => c.type === "error"), false);
    assert.equal(chunks.filter(c => c.type === "text").map(c => c.content).join(""), "OK");
    assert.equal(requests.length, 1, "adapt the first request instead of retrying a deterministic rejection");
    assert.equal(requests[0]!.temperature, 1);
    assert.equal(requests[0]!.top_k, 100);
    assert.equal(requests[0]!.top_p, 0.95);
    assert.equal(requests[0]!.min_p, 0.16);
    assert.equal(requests[0]!.frequency_penalty, 0.55);
    assert.equal(requests[0]!.presence_penalty, 0.35);
    assert.deepEqual(requests[0]!.reasoning, { effort: "high" });
    assert.equal(params.temperature, 1.1, "do not rewrite the user's shared preferences");
    assert.equal(params.topK, 200);
  });
}
