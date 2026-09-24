import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MODEL } from "@yumina/shared";
import { composeSelectedModelId } from "./model-id";
import { resolveOfficialSelectedModel, resolvePrivateSelectedModel } from "./provider-model-selection";

test("composeSelectedModelId prefixes custom models even when upstream ids contain slashes", () => {
  assert.equal(composeSelectedModelId("custom", "gpt-4o"), "custom/gpt-4o");
  assert.equal(composeSelectedModelId("custom", "openai/gpt-4o"), "custom/openai/gpt-4o");
  assert.equal(composeSelectedModelId("custom", "custom/openai/gpt-4o"), "custom/openai/gpt-4o");
});

test("composeSelectedModelId keeps OpenRouter-style ids unprefixed", () => {
  assert.equal(composeSelectedModelId("openrouter", "anthropic/claude-sonnet-4.6"), "anthropic/claude-sonnet-4.6");
});

test("resolveOfficialSelectedModel replaces non-official current models", () => {
  // Free plan can't access DEFAULT_MODEL — falls back to the first free-tier model.
  assert.equal(resolveOfficialSelectedModel("custom/openai/gpt-4o", "free"), "openrouter/free");
  // Plans with access to DEFAULT_MODEL get it.
  assert.equal(resolveOfficialSelectedModel("custom/openai/gpt-4o", "plus"), DEFAULT_MODEL);
});

test("resolveOfficialSelectedModel keeps a local model on the way back from BYOK", () => {
  // The server routes `local/` by prefix ahead of the provider branch, so
  // rewriting it here would swap the player's own GPU for a paid model.
  assert.equal(resolveOfficialSelectedModel("local/qwen3:8b", "free"), "local/qwen3:8b");
  assert.equal(resolveOfficialSelectedModel("local/qwen3:8b", "plus"), "local/qwen3:8b");
});

test("resolvePrivateSelectedModel prefers the active profile default model", () => {
  const selected = resolvePrivateSelectedModel(
    [
      { id: "older", provider: "custom", metadata: { defaultModel: "openai/old" } },
      { id: "active", provider: "custom", metadata: { defaultModel: "openai/gpt-4o" } },
    ],
    "active",
  );
  assert.equal(selected, "custom/openai/gpt-4o");
});
