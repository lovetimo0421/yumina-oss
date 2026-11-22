import test from "node:test";
import assert from "node:assert/strict";
import { foldStateBlockIntoPlayerTurn, stateBlockGoesInPlayerTurn } from "./state-block-placement.js";

type M = { role: "user" | "assistant" | "system"; content: string; sourceMessageId?: string };
const BLOCK = "<game-state>\naffection: 10\n</game-state>\n<state-reminder>\nwrite directives\n</state-reminder>";

test("state block placement: only the listed families, incl. custom endpoint ids", () => {
  for (const id of [
    "deepseek/deepseek-v3.2", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4.1-flash-1017", "deepseek/deepseek-chat:free",
    "xiaomi/mimo-v2-flash", "z-ai/glm-4.6", "z-ai/glm-5",
    "custom/deepseek-chat", "custom/deepseek-ai/DeepSeek-V3.2", "custom/Pro/deepseek-ai/DeepSeek-V3", "custom/zai-org/GLM-4.6",
    "custom/glm-4.6", "custom/mimo-v2-flash",
  ]) assert.equal(stateBlockGoesInPlayerTurn(id), true, id);
  for (const id of [
    "anthropic/claude-sonnet-4.6", "google/gemini-3.5-flash-lite", "openai/gpt-6.2", "moonshotai/kimi-k2.6",
    "xiaomi/other-model", "z-ai/other", "custom/claude-sonnet", "custom/my-deepseek-proxy", "local/qwen3", "",
  ]) assert.equal(stateBlockGoesInPlayerTurn(id), false, id);
});

test("state block placement: appended to the player's final message after a blank line", () => {
  const history: M[] = [
    { role: "user", content: "hi", sourceMessageId: "1" },
    { role: "assistant", content: "hello", sourceMessageId: "2" },
    { role: "user", content: "I wave.", sourceMessageId: "3" },
  ];
  const before = structuredClone(history);
  const target = foldStateBlockIntoPlayerTurn("deepseek/deepseek-v3.2", BLOCK, history, new Set());
  assert.equal(target, history[2]);
  assert.equal(history[2]!.content, `I wave.\n\n${BLOCK}`);
  assert.deepEqual(history.slice(0, 2), before.slice(0, 2));
});

test("state block placement: other models and non-player endings keep the system message", () => {
  const mk = (): M[] => [
    { role: "user", content: "hi", sourceMessageId: "1" },
    { role: "assistant", content: "partial reply", sourceMessageId: "2" },
  ];
  // continue: the history ends on the assistant's partial reply
  const cont = mk();
  assert.equal(foldStateBlockIntoPlayerTurn("deepseek/deepseek-v3.2", BLOCK, cont, new Set()), null);
  assert.deepEqual(cont, mk());
  // a model outside the list, even when the history ends on the player
  const sent: M[] = [...mk(), { role: "user", content: "go on", sourceMessageId: "3" }];
  for (const model of ["anthropic/claude-sonnet-4.6", "google/gemini-3.5-flash-lite"]) {
    assert.equal(foldStateBlockIntoPlayerTurn(model, BLOCK, sent, new Set()), null);
    assert.equal(sent[2]!.content, "go on");
  }
  // an archived-run summary (no stored id) is not the player's message
  const folded: M[] = [{ role: "user", content: "[archived run]" }];
  assert.equal(foldStateBlockIntoPlayerTurn("z-ai/glm-4.6", BLOCK, folded, new Set()), null);
  // empty block, empty history
  assert.equal(foldStateBlockIntoPlayerTurn("z-ai/glm-4.6", "", sent, new Set()), null);
  assert.equal(foldStateBlockIntoPlayerTurn("z-ai/glm-4.6", BLOCK, [], new Set()), null);
});

test("state block placement: depth-0 lore after the player's message is stepped over", () => {
  const depthUser: M = { role: "user", content: "[lore at depth 0]" };
  const depthSystem: M = { role: "system", content: "[more lore]" };
  const history: M[] = [
    { role: "assistant", content: "hello", sourceMessageId: "1" },
    { role: "user", content: "I look around.", sourceMessageId: "2" },
    depthUser,
    depthSystem,
  ];
  const target = foldStateBlockIntoPlayerTurn("xiaomi/mimo-v2-flash", BLOCK, history, new Set([depthUser, depthSystem]));
  assert.equal(target, history[1]);
  assert.equal(history[1]!.content, `I look around.\n\n${BLOCK}`);
  assert.equal(depthUser.content, "[lore at depth 0]");
  assert.equal(depthSystem.content, "[more lore]");
});

test("state block placement: an image-only player message gets the block alone", () => {
  const history: M[] = [{ role: "user", content: "", sourceMessageId: "1" }];
  foldStateBlockIntoPlayerTurn("deepseek/deepseek-v3.2", BLOCK, history, new Set());
  assert.equal(history[0]!.content, BLOCK);
});
