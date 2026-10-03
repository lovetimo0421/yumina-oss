import assert from "node:assert/strict";
import test from "node:test";
import { familyOf as serverFamilyOf } from "@yumina/engine";
import { familyOf } from "./model-families";

// The chat's "this prompt applies on this model" line must match the prompt
// the server really sends. BYOK, custom-endpoint and local ids are where a
// second copy of the classifier used to drift.
const ids = [
  "google/gemini-2.5-flash", "anthropic/claude-sonnet-4.5", "deepseek/deepseek-chat-v3.1",
  "claude-3-5-sonnet-20241022", "gpt-4o", "deepseek-chat", "o3-mini",
  "local/qwen3:8b", "local/gpt-oss:20b", "local/deepseek-r1:8b", "ollama/llama3",
  "custom/my-model", "custom/MiniMax-M2", "MiniMax-M1", "custom/openai-compatible/foo",
  "custom/moonshot-v1-8k", "moonshotai/kimi-k2", "custom/glm-4.6", "", null, undefined,
];

test("the app classifies every model id exactly as the server does", () => {
  for (const id of ids) assert.equal(familyOf(id), serverFamilyOf(id), String(id));
});

test("custom-endpoint MiniMax is minimax on both sides, not other", () => {
  assert.equal(familyOf("custom/MiniMax-M2"), "minimax");
  assert.equal(familyOf("local/qwen3:8b"), "other");
});
