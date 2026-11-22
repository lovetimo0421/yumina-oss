import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalBridgeProvider, DEFAULT_LOCAL_CONTEXT, LOCAL_MAX_OUTPUT_TOKENS } from "./local-bridge.js";
import { setAdvertisedModels } from "../local-bridge/registry.js";
import { clampMaxContextToModel } from "./context-window.js";

test("a local model's budget follows the window its runtime reported", async () => {
  // LM Studio loads at whatever context the player picked — 8K by default.
  // Packing our usual 32K prompt into that fails the turn.
  setAdvertisedModels("player-ctx", [
    { id: "mistral-7b", contextLength: 8192 },
    { id: "qwen/qwen3.8-27b", contextLength: 262144 },
    { id: "qwen3.5:9b" },
  ]);
  const provider = new LocalBridgeProvider("player-ctx");

  assert.equal(await provider.getContextWindow("local/mistral-7b"), 8192);
  assert.equal(await provider.getContextWindow("local/qwen3.5:9b"), undefined);
  assert.equal(await provider.getContextWindow("local/not-advertised"), undefined);
  assert.equal(await provider.getContextWindow(), undefined);

  const budget = async (model: string) =>
    clampMaxContextToModel(200_000, model, 4096, undefined, await provider.getContextWindow(model));
  // Smaller than ours: the budget comes down to fit it.
  assert.equal(await budget("local/mistral-7b"), Math.floor((8192 - LOCAL_MAX_OUTPUT_TOKENS) * 0.85));
  // Bigger than ours, or unknown: still our window — a huge context costs prefill time, not quality.
  const ours = Math.floor((DEFAULT_LOCAL_CONTEXT - LOCAL_MAX_OUTPUT_TOKENS) * 0.85);
  assert.equal(await budget("local/qwen/qwen3.8-27b"), ours);
  assert.equal(await budget("local/qwen3.5:9b"), ours);
});
