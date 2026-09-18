import test from "node:test";
import assert from "node:assert/strict";
import type { StudioChatMessage } from "./types";
import { selectScopedStudioHistory, shouldAcceptStudioChatScope, shouldReuseStudioHistory } from "./agent-history-scope";

const messages: StudioChatMessage[] = [
  { id: "a1", role: "user", content: "A secret" },
  { id: "a2", role: "assistant", content: "A answer" },
];

test("reuses Studio history only when world and conversation match", () => {
  assert.equal(
    shouldReuseStudioHistory(
      { worldId: "world-a", conversationId: "conv-a" },
      { worldId: "world-a", conversationId: "conv-a" },
    ),
    true,
  );

  assert.equal(
    shouldReuseStudioHistory(
      { worldId: "world-a", conversationId: "conv-a" },
      { worldId: "world-b", conversationId: "conv-a" },
    ),
    false,
  );

  assert.equal(
    shouldReuseStudioHistory(
      { worldId: "world-a", conversationId: "conv-a" },
      { worldId: "world-a", conversationId: "conv-b" },
    ),
    false,
  );
});

test("selectScopedStudioHistory returns empty history for cross-world requests", () => {
  assert.deepEqual(
    selectScopedStudioHistory(messages, { worldId: "world-a", conversationId: "conv-a" }, { worldId: "world-b", conversationId: "conv-b" }),
    [],
  );

  assert.deepEqual(
    selectScopedStudioHistory(messages, { worldId: "world-a", conversationId: "conv-a" }, { worldId: "world-a", conversationId: "conv-a" }),
    messages,
  );
});

test("shouldAcceptStudioChatScope lets an empty unclaimed chat start a new conversation", () => {
  assert.equal(
    shouldAcceptStudioChatScope(
      { worldId: null, conversationId: null },
      { worldId: "world-a", conversationId: "conv-a" },
      0,
    ),
    true,
  );

  assert.equal(
    shouldAcceptStudioChatScope(
      { worldId: null, conversationId: null },
      { worldId: "world-a", conversationId: "conv-a" },
      1,
    ),
    false,
  );

  assert.equal(
    shouldAcceptStudioChatScope(
      { worldId: "world-a", conversationId: "conv-a" },
      { worldId: "world-a", conversationId: "conv-b" },
      0,
    ),
    false,
  );
});

test("selectScopedStudioHistory caps same-scope history at the most recent messages", () => {
  const manyMessages = Array.from({ length: 45 }, (_, index): StudioChatMessage => ({
    id: `m-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
  }));

  const selected = selectScopedStudioHistory(
    manyMessages,
    { worldId: "world-a", conversationId: "conv-a" },
    { worldId: "world-a", conversationId: "conv-a" },
  );

  assert.equal(selected.length, 40);
  assert.equal(selected[0]!.id, "m-5");
  assert.equal(selected[39]!.id, "m-44");
});
