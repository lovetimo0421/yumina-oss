import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenRouterProvider } from "./openrouter.js";
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { OllamaProvider } from "./ollama.js";
import { CustomProvider } from "./custom.js";
import { assertImageModel } from "./image-capability.js";
import { getOfficialProviderFallbackModels } from "./fallback-models.js";

const image = "data:image/png;base64,aGVsbG8=";
for (const [name, provider, model] of [
  ["openrouter", new OpenRouterProvider("synthetic"), "google/gemini-2.5-flash"],
  ["openai", new OpenAIProvider("synthetic"), "openai/gpt-4o"],
  ["anthropic", new AnthropicProvider("synthetic"), "anthropic/claude-sonnet-4"],
  ["google", new GoogleProvider("synthetic"), "google/gemini-2.5-flash"],
  ["ollama", new OllamaProvider(), "ollama/llava"],
  ["custom", new CustomProvider("synthetic", "https://synthetic.example/v1"), "custom/vision"],
] as const) {
  test(`${name} sends image bytes in the provider-native request`, async t => {
    let captured: Record<string, any> | undefined;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      if (!init?.body) return Response.json({ data: [] });
      captured = JSON.parse(String(init.body));
      return Response.json({ choices: [{ message: { content: "Seen" }, finish_reason: "stop" }],
        content: [{ type: "text", text: "Seen" }], stop_reason: "end_turn",
        candidates: [{ content: { parts: [{ text: "Seen" }] }, finishReason: "STOP" }],
        message: { content: "Seen" }, done: true,
        usage: { prompt_tokens: 1, completion_tokens: 1, input_tokens: 1, output_tokens: 1 },
      });
    });
    const chunks = [];
    for await (const chunk of provider.generateStream({ model, stream: false, singleAttempt: true,
      messages: [{ role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: image } }] }],
    })) chunks.push(chunk);
    assert.ok(captured);
    if (name === "google") assert.deepEqual(captured.contents[0].parts[1], { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } });
    else if (name === "anthropic") assert.equal(captured.messages[0].content[1].source.data, "aGVsbG8=");
    else if (name === "ollama") assert.deepEqual(captured.messages[0].images, ["aGVsbG8="]);
    else assert.equal(captured.messages[0].content.find((p: any) => p.type === "image_url").image_url.url, image);
    assert.ok(chunks.some(c => c.type === "text" && c.content === "Seen"));
  });
}

test("known text-only models reject images; unknown custom endpoints keep their own capabilities", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { id: "deepseek/deepseek-v3.2", context_length: 163840, architecture: { input_modalities: ["text"] } },
    { id: "google/gemini-2.5-flash", context_length: 1048576, architecture: { input_modalities: ["text", "image"] } },
  ] }));
  const provider = new OpenRouterProvider("synthetic");
  await assert.rejects(assertImageModel({ providerName: "openrouter", provider }, "deepseek/deepseek-v3.2"), { name: "ImageModelError" });
  await assertImageModel({ providerName: "openrouter", provider }, "google/gemini-2.5-flash");
  await assertImageModel({ providerName: "custom", provider }, "deepseek/deepseek-v3.2");
  assert.deepEqual(getOfficialProviderFallbackModels("openrouter/free", false, true), ["qwen/qwen3-vl-30b-a3b-instruct", "mistralai/mistral-small-3.2-24b-instruct"]);
});
