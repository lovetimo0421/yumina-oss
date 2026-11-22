import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import { __setInstalledLookupForTests, type HookSessionRow } from "../../lib/extension-hooks.js";
import { loadTurnMemoryBlocks } from "../../lib/turn-memory.js";
import { registerSessionMemoryExtension } from "./hooks.js";

// The player's pinned notes (playSessions.sessionMemoryPinned) are their own
// standing text: free, never auto-edited. They are a core prompt block, sent
// whether or not the memory extension is installed and whether or not its
// auto memory is on, ahead of the auto-written memory they may override.

describe("pinned notes prompt block", () => {
  let installed = true;
  before(() => {
    registerSessionMemoryExtension();
    __setInstalledLookupForTests(async () => new Set(installed ? [SESSION_MEMORY_EXTENSION_KEY] : []));
  });
  after(() => __setInstalledLookupForTests(null));

  // The recap is on for everyone by default; these players switched it off
  // in AI settings, so no test touches the DB.
  async function blocks(session: HookSessionRow) {
    const turn = await loadTurnMemoryBlocks({ ownerUserId: "u1", sessionId: "s1", session, recap: { chosenShare: "off", storyMemory: 16_000 } });
    return turn.blocks;
  }

  // Story summary + layered summary off so the test never touches the DB.
  const base: HookSessionRow = { summaryIncluded: false, summaryceptionIncluded: false };
  const pinnedText = "the stranger is the hero's father";

  it("sends pinned notes ahead of the auto memory, in their own block", async () => {
    installed = true;
    const list = await blocks({ ...base, sessionMemoryIncluded: true, sessionMemory: { text: "- the hero met the stranger" }, sessionMemoryPinned: pinnedText });
    const pinned = list.findIndex((b) => b.id === "pinned-notes");
    const memory = list.findIndex((b) => b.id === "session-memory");
    assert.ok(pinned >= 0 && list[pinned]!.content?.includes(pinnedText));
    assert.ok(memory > pinned, "pinned notes come before the auto memory");
    assert.ok(!list[memory]!.content?.includes(pinnedText), "the auto memory block no longer repeats them");
  });

  it("sends pinned notes when the auto memory is switched off", async () => {
    installed = true;
    const list = await blocks({ ...base, sessionMemoryIncluded: false, sessionMemory: { text: "- the hero met the stranger" }, sessionMemoryPinned: pinnedText });
    assert.ok(list.find((b) => b.id === "pinned-notes")?.content?.includes(pinnedText));
    assert.equal(list.find((b) => b.id === "session-memory")?.content ?? null, null, "auto memory stays out when disabled");
  });

  it("sends pinned notes without the memory extension", async () => {
    installed = false;
    const list = await blocks({ ...base, sessionMemoryPinned: pinnedText });
    assert.ok(list.find((b) => b.id === "pinned-notes")?.content?.includes(pinnedText));
    assert.equal(list.some((b) => b.id === "session-memory"), false, "no extension, no extension blocks");
  });

  it("adds nothing when there are no pinned notes", async () => {
    installed = false;
    const list = await blocks({ ...base, sessionMemoryPinned: "   " });
    assert.equal(list.some((b) => b.id === "pinned-notes"), false);
  });
});
