import test from "node:test";
import assert from "node:assert/strict";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import {
  PromptBlockController,
  __setInstalledLookupForTests,
  collectExtensionInvalidation,
  collectPromptBlocks,
  registerExtensionHooks,
  resolveTurnHooks,
  type BlockPosition,
  type TurnPromptMessageLike,
} from "./extension-hooks.js";

const KEY = SESSION_MEMORY_EXTENSION_KEY;
const baseCtx = { ownerUserId: "u1", sessionId: "s1", session: {} };

function makeController(args?: { withSummary?: boolean }) {
  // Layout: [system prefix][story-summary?][history x2] — summaryception and
  // session-memory reserved but absent, mirroring a real injection pass.
  const messages: TurnPromptMessageLike[] = [{ role: "system", content: "prefix" }];
  const positions = new Map<string, BlockPosition>();
  let cursor = messages.length;
  if (args?.withSummary) {
    positions.set("story-summary", { index: cursor, insertIndex: cursor, rank: 0 });
    messages.push({ role: "system", content: "old summary" });
    cursor += 1;
  } else {
    positions.set("story-summary", { index: null, insertIndex: cursor, rank: 0 });
  }
  positions.set("summaryception", { index: null, insertIndex: cursor, rank: 1 });
  const historyStart = messages.length;
  messages.push(
    { role: "user", content: "h1", sourceMessageId: "m1" },
    { role: "assistant", content: "h2", sourceMessageId: "m2" },
  );
  const controller = new PromptBlockController({ messages, positions, historyStart });
  return { messages, positions, controller, historyStart };
}

test("controller replaces a present block in place", () => {
  const { messages, controller, historyStart } = makeController({ withSummary: true });
  controller.upsertBlock("story-summary", "new summary");
  assert.equal(messages[1]!.content, "new summary");
  assert.equal(controller.historyStart, historyStart);
  assert.equal(messages.length, 4);
});

test("controller inserts an absent block at its reserved position and shifts the boundary", () => {
  const { messages, controller, historyStart } = makeController({ withSummary: true });
  controller.upsertBlock("summaryception", "snippets");
  assert.equal(messages[2]!.content, "snippets");
  assert.equal(controller.historyStart, historyStart + 1);
  assert.equal(messages[3]!.sourceMessageId, "m1");
});

test("same-point insertions land in canonical order regardless of upsert order", () => {
  // Neither block present; both reserve position 1. Upserting summaryception
  // FIRST (the real overflow order) must still leave story-summary before it.
  const { messages, controller } = makeController();
  controller.upsertBlock("summaryception", "snippets");
  controller.upsertBlock("story-summary", "summary");
  assert.deepEqual(
    messages.map((m) => m.content),
    ["prefix", "summary", "snippets", "h1", "h2"],
  );
  // Two insertions before history → boundary moved by 2.
  assert.equal(controller.historyStart, 3);
});

test("controller ignores null content and unknown block ids", () => {
  const { messages, controller, historyStart } = makeController();
  controller.upsertBlock("story-summary", null);
  controller.upsertBlock("not-a-block", "boom");
  assert.equal(messages.length, 3);
  assert.equal(controller.historyStart, historyStart);
});

test("controller drops covered raw-history messages by source id", () => {
  const { messages, controller } = makeController({ withSummary: true });
  controller.removeHistoryMessagesBySource(["m1"]);
  assert.deepEqual(messages.map((m) => m.content), ["prefix", "old summary", "h2"]);
});

test("prompt blocks are entitlement-gated; invalidate is not", async () => {
  registerExtensionHooks(KEY, {
    resolveCapabilities: () => ["session-memory"],
    contributePromptBlocks: (ctx) => [
      { id: "b", priority: 20, content: ctx.capabilities.has("session-memory") ? "block-b" : null },
      { id: "a", priority: 10, content: "block-a" },
    ],
    invalidate: (ctx) => ({ sessionFields: { sessionMemory: null }, runAfter: async () => { ran.push(ctx.reason); } }),
  });
  const ran: string[] = [];

  try {
    // Not installed → no dispatch entries → no blocks.
    __setInstalledLookupForTests(async () => new Set());
    let dispatch = await resolveTurnHooks(baseCtx);
    assert.equal(dispatch.activeExtensions.size, 0);
    assert.deepEqual(await collectPromptBlocks(dispatch, { ...baseCtx, freshStart: false }), []);

    // Installed → blocks collected, priority-sorted.
    __setInstalledLookupForTests(async () => new Set([KEY]));
    dispatch = await resolveTurnHooks(baseCtx);
    assert.deepEqual(dispatch.activeExtensions.get(KEY), new Set(["session-memory"]));
    const blocks = await collectPromptBlocks(dispatch, { ...baseCtx, freshStart: false });
    assert.deepEqual(blocks.map((b) => b.id), ["a", "b"]);

    // Invalidation collects from every REGISTERED extension — install state
    // is deliberately irrelevant (data lifecycle outlives uninstall).
    __setInstalledLookupForTests(async () => new Set());
    const plan = collectExtensionInvalidation({ reason: "session-restart", sessionId: "s1" });
    assert.deepEqual(plan.sessionFields, { sessionMemory: null });
    await plan.runAfter();
    assert.deepEqual(ran, ["session-restart"]);
  } finally {
    __setInstalledLookupForTests(null);
  }
});

test("registering an unknown extension key is refused", async () => {
  registerExtensionHooks("not-a-real-extension", {
    contributePromptBlocks: () => [{ id: "x", priority: 0, content: "x" }],
  });
  __setInstalledLookupForTests(async () => new Set(["not-a-real-extension"]));
  try {
    const dispatch = await resolveTurnHooks(baseCtx);
    assert.equal(dispatch.activeExtensions.has("not-a-real-extension"), false);
  } finally {
    __setInstalledLookupForTests(null);
  }
});
