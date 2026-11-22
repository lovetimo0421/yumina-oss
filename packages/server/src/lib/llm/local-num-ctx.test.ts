import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOCAL_CONTEXT, MIN_LOCAL_CONTEXT, localNumCtx } from "./local-bridge.js";
import { clampMaxContextToModel } from "./context-window.js";

test("a 12K story context with a 300-token reply asks for ~14.8K, not 32K", () => {
  // The reported case: qwen3.5:9b, story context 12K, reply 300. Every turn
  // loaded a 32K window the player's machine couldn't hold.
  const budget = clampMaxContextToModel(12_000, "local/qwen3.5:9b", 300, undefined);
  assert.equal(budget, 12_000);
  assert.equal(localNumCtx({ contextBudget: budget, promptTokens: 9_000, outputTokens: 300 }), 14_848);
});

test("a budget clamped to the local window maps back to exactly the 32K ceiling", () => {
  const budget = clampMaxContextToModel(200_000, "local/qwen3.5:9b", 300, undefined);
  assert.equal(localNumCtx({ contextBudget: budget, promptTokens: budget, outputTokens: 300 }), DEFAULT_LOCAL_CONTEXT);
});

test("tiny budgets still get the floor", () => {
  assert.equal(localNumCtx({ contextBudget: 1_000, promptTokens: 500, outputTokens: 256 }), MIN_LOCAL_CONTEXT);
});

test("a prompt that outgrew its budget is never truncated by num_ctx", () => {
  assert.equal(localNumCtx({ contextBudget: 8_000, promptTokens: 12_000, outputTokens: 300 }), 14_848);
});

test("without a budget the window follows the prompt itself", () => {
  assert.equal(localNumCtx({ promptTokens: 6_000, outputTokens: 2_048 }), 9_216);
});

test("a runtime that reports a smaller window caps the request", () => {
  assert.equal(localNumCtx({ contextBudget: 24_000, promptTokens: 20_000, outputTokens: 300, windowCap: 16_384 }), 16_384);
});

test("a background call reuses the story turn's window so Ollama doesn't reload", () => {
  const key = "bridge:u1:qwen3.5:9b";
  assert.equal(localNumCtx({ contextBudget: 12_000, promptTokens: 9_000, outputTokens: 300, stickyKey: key }), 14_848);
  assert.equal(localNumCtx({ promptTokens: 3_000, outputTokens: 1_024, stickyKey: key }), 14_848);
  // One that doesn't fit the story's window still gets what it needs.
  assert.equal(localNumCtx({ promptTokens: 16_000, outputTokens: 1_024, stickyKey: key }), 19_968);
  // Another model on the same runtime is sized on its own.
  assert.equal(localNumCtx({ promptTokens: 3_000, outputTokens: 1_024, stickyKey: "bridge:u1:other" }), 4_608);
});
