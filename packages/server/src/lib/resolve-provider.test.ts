import assert from "node:assert/strict";
import test from "node:test";
import { inferProvider } from "./llm/provider-factory.js";

test("inferProvider: custom/ prefix maps to custom", () => {
  assert.equal(inferProvider("custom/gemini-3.1-pro-preview"), "custom");
});

test("inferProvider: custom/ prefix with nested slashes still routes to custom", () => {
  // User's whitelist might contain "openai/gpt-4o" — stored as "custom/openai/gpt-4o"
  assert.equal(inferProvider("custom/openai/gpt-4o"), "custom");
});

test("inferProvider: non-custom prefixes still work", () => {
  assert.equal(inferProvider("openai/gpt-4o"), "openai");
  assert.equal(inferProvider("anthropic/claude-sonnet-4.6"), "anthropic");
  assert.equal(inferProvider("google/gemini-3-flash-preview"), "google");
  assert.equal(inferProvider("ollama/llama3"), "ollama");
  assert.equal(inferProvider("deepseek/deepseek-v3.2"), "openrouter"); // default
});
