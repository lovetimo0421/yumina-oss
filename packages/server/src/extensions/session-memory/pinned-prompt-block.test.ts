import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import {
  __setInstalledLookupForTests,
  collectPromptBlocks,
  resolveTurnHooks,
  type HookSessionRow,
} from "../../lib/extension-hooks.js";
import { registerSessionMemoryExtension } from "./hooks.js";

// The [Session Memory] prompt block carries the player's pinned notes. They
// are the player's own standing text (playSessions.sessionMemoryPinned), so
// they must reach the prompt even when the auto memory is switched off, and
// must sit ahead of the auto-written memory they are allowed to override.

describe("session-memory prompt block: pinned notes", () => {
  before(() => {
    registerSessionMemoryExtension();
    __setInstalledLookupForTests(async () => new Set([SESSION_MEMORY_EXTENSION_KEY]));
  });
  after(() => __setInstalledLookupForTests(null));

  async function memoryBlock(session: HookSessionRow): Promise<string | null> {
    const ctx = { ownerUserId: "u1", sessionId: "s1", session, freshStart: false };
    const dispatch = await resolveTurnHooks(ctx);
    const blocks = await collectPromptBlocks(dispatch, ctx);
    const block = blocks.find((b) => b.id === "session-memory");
    assert.ok(block, "the session-memory slot is always contributed");
    return block!.content;
  }

  // Story summary + layered summary off so the test never touches the DB.
  const base: HookSessionRow = { summaryIncluded: false, summaryceptionIncluded: false };

  it("injects pinned notes ahead of the auto memory", async () => {
    const content = await memoryBlock({
      ...base,
      sessionMemoryIncluded: true,
      sessionMemory: { text: "- the hero met the stranger" },
      sessionMemoryPinned: "the stranger is the hero's father",
    });
    assert.ok(content);
    assert.ok(content!.indexOf("the stranger is the hero's father") < content!.indexOf("- the hero met the stranger"));
  });

  it("still injects pinned notes when the auto memory is switched off", async () => {
    const content = await memoryBlock({
      ...base,
      sessionMemoryIncluded: false,
      sessionMemory: { text: "- the hero met the stranger" },
      sessionMemoryPinned: "the stranger is the hero's father",
    });
    assert.ok(content);
    assert.ok(content!.includes("the stranger is the hero's father"));
    assert.ok(!content!.includes("- the hero met the stranger"), "auto memory stays out when disabled");
  });

  it("contributes an empty slot when there is neither memory nor pinned notes", async () => {
    const content = await memoryBlock({ ...base, sessionMemoryIncluded: true, sessionMemory: null, sessionMemoryPinned: null });
    assert.equal(content, null);
  });
});
