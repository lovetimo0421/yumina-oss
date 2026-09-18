import assert from "node:assert/strict";
import test from "node:test";
import { createByokProvider, createProvider } from "./provider-factory.js";

for (const byok of [false, true]) {
  for (const stream of [true, false]) {
    test(`${byok ? "BYOK" : "official"} ${stream ? "streaming" : "non-streaming"} usage belongs to Yumina's canonical app`, async t => {
      const requests: Array<{ url: string; init: RequestInit }> = [];
      t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init: RequestInit) => {
        requests.push({ url: String(url), init });
        const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
        return stream
          ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }], usage })}\n\ndata: [DONE]\n\n`,
              { headers: { "Content-Type": "text/event-stream" } })
          : Response.json({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }], usage });
      });
      const key = byok ? "user-owned-test-key" : "platform-test-key";
      const provider = byok ? createByokProvider("openrouter", key) : createProvider("openrouter", key);
      const messages = [{ role: "user" as const, content: "Continue the story." }];
      let reply = "";
      for await (const chunk of provider.generateStream({
        model: "google/gemini-3.1-flash-lite", messages, stream, maxTokens: 128, temperature: 0.6,
      })) {
        if (chunk.type === "text") reply += chunk.content;
      }
      assert.equal(reply, "Hello");
      assert.equal(requests.length, 1);
      const { url, init } = requests[0]!;
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(init.method, "POST");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("HTTP-Referer"), "https://yumina.io");
      assert.equal(headers.get("X-OpenRouter-Title"), "Yumina");
      assert.equal(headers.get("X-OpenRouter-Categories"), "roleplay,game");
      assert.equal(headers.get("Authorization"), `Bearer ${key}`);
      assert.equal(headers.get("Content-Type"), "application/json");
      assert.equal(headers.get("X-OpenRouter-Metadata"), "enabled");
      const body = JSON.parse(String(init.body));
      assert.equal(body.model, "google/gemini-3.1-flash-lite");
      assert.deepEqual(body.messages, messages);
      assert.equal(body.stream, stream);
      assert.equal(body.max_tokens, 128);
      assert.equal(body.temperature, 0.6);
      assert.deepEqual(body.provider, byok ? undefined : { order: ["google-ai-studio"], allow_fallbacks: true });
    });
  }
}
