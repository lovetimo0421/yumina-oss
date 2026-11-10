import { test } from "node:test";
import assert from "node:assert/strict";
import { toWireContent } from "./wire-content.js";
import { CustomProvider } from "./custom.js";
import { OpenAIProvider } from "./openai.js";
import type { ContentPart, GenerateParams, StreamChunk } from "./types.js";

// The Studio's system prompt as agent.ts builds it: three text blocks, two cache-marked.
const studioSystem: ContentPart[] = [
  { type: "text", text: "<identity>static</identity>", cache_control: { type: "ephemeral", ttl: "1h" } },
  { type: "text", text: "<world>card</world>", cache_control: { type: "ephemeral", ttl: "5m" } },
  { type: "text", text: "<context>panel</context>" },
];

async function drain(stream: AsyncIterable<StreamChunk>) {
  for await (const _ of stream) { /* consume */ }
}

test("text-only parts become one string, in order", () => {
  assert.equal(toWireContent(studioSystem), "<identity>static</identity>\n\n<world>card</world>\n\n<context>panel</context>");
  assert.equal(toWireContent("plain"), "plain");
});

test("parts with an image stay parts, without cache marks", () => {
  const image: ContentPart = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
  assert.deepEqual(toWireContent([{ type: "text", text: "look", cache_control: { type: "ephemeral" } }, image]), [
    { type: "text", text: "look" },
    image,
  ]);
});

for (const [name, make] of [
  ["custom endpoint", () => new CustomProvider("key", "https://api.mistral.ai/v1")],
  ["OpenAI", () => new OpenAIProvider("key")],
] as const) {
  test(`${name}: the Studio's system prompt goes out as a string`, async (t) => {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    });
    const params: GenerateParams = {
      model: name === "OpenAI" ? "gpt-5.6" : "custom/mistral-medium-2508",
      messages: [{ role: "system", content: studioSystem }, { role: "user", content: "hi" }],
    };
    await drain(make().generateStream(params));
    const sent = bodies[0]!.messages;
    assert.equal(typeof sent[0]!.content, "string");
    assert.doesNotMatch(JSON.stringify(sent), /cache_control/);
  });
}
