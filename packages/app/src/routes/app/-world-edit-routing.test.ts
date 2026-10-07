import assert from "node:assert/strict";
import test from "node:test";
import { prepareStudioEntry, resolveEditorMode } from "../../features/editor/editor-entry";
import { backupEditorDraft } from "../../features/editor/editor-draft-recovery";
import { getEditorMode, getGlobalEditorMode, rememberEditorChoice } from "../../features/editor/lib/editor-mode";
import { getEditorSurface, shouldOpenVisual } from "../../lib/editor-surface";

test("this card's local choice wins, then the saved mode, then the global one, then advanced", () => {
  // Switching to simple does not dirty the draft, so a reload right after it
  // still loads editorMode "advanced" from the server: the local choice must
  // win or simple mode is lost on refresh.
  assert.equal(resolveEditorMode("advanced", "simple", "advanced"), "simple");
  assert.equal(resolveEditorMode("simple", "advanced", "simple"), "advanced");
  // Another device has no local choice for this card and goes by the saved one.
  assert.equal(resolveEditorMode("simple", null, "advanced"), "simple");
  assert.equal(resolveEditorMode("advanced", null, "simple"), "advanced");
  assert.equal(resolveEditorMode(undefined, null, "simple"), "simple");
  assert.equal(resolveEditorMode(undefined, null, null), "advanced");
});

test("Studio handoff saves once and never opens after failure or mid-save edits", async () => {
  let saves = 0;
  const state = { worldDraft: { id: "draft" }, serverWorldId: "server", isDirty: true, saving: false,
    saveDraft: async () => { saves++; state.isDirty = false; return true; } };
  assert.equal(await prepareStudioEntry(() => state), "server");
  assert.equal(saves, 1);
  assert.equal(await prepareStudioEntry(() => state), "server");
  assert.equal(saves, 1, "clean reopen does not issue another save");
  state.isDirty = true;
  state.saveDraft = async () => false;
  assert.equal(await prepareStudioEntry(() => state), null);
  state.saveDraft = async () => true;
  assert.equal(await prepareStudioEntry(() => state), null, "dirty drift cannot navigate");
  state.saving = true;
  state.saveDraft = async () => { throw new Error("must not save concurrently"); };
  assert.equal(await prepareStudioEntry(() => state), null);
});

test("a handoff response from another card cannot navigate the current editor", async () => {
  const state = { worldDraft: { id: "first" }, serverWorldId: "server-first", isDirty: true, saving: false,
    saveDraft: async () => { state.worldDraft = { id: "second" }; state.serverWorldId = "server-second"; state.isDirty = false; return true; } };
  assert.equal(await prepareStudioEntry(() => ({ ...state })), null);
});

test("leaving immediately writes the recovery format, preserving layout-only edits", () => {
  const storage = new Map<string, string>();
  const state = { worldDraft: { id: "schema-id", entries: [{ content: "刚写下的内容" }] }, serverWorldId: "server-id", isDirty: true, layoutDirty: false, guestMode: false, readOnlyInspect: false };
  const writer = { setItem: (key: string, value: string) => { storage.set(key, value); } };
  assert.equal(backupEditorDraft(state, writer, 1234), true);
  assert.deepEqual(JSON.parse(storage.get("yumina-editor-draft")!), { draft: state.worldDraft, serverId: "server-id", savedAt: 1234, baseUpdatedAt: null });
  assert.equal(backupEditorDraft({ ...state, isDirty: false, layoutDirty: true }, writer), true);
  for (const blocked of [{ ...state, guestMode: true }, { ...state, readOnlyInspect: true }, { ...state, isDirty: false }]) {
    assert.equal(backupEditorDraft(blocked, writer), false);
  }
  assert.equal(backupEditorDraft(state, { setItem: () => { throw new Error("quota exceeded"); } }), false);
});

test("every way between 简单 / 完整 / 画布 (the 画布 pill and the ⋮ items) is where /edit opens the card next", () => {
  const data = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) },
  });
  // What worlds.$worldId.edit.tsx decides for a card whose saved field still
  // says `serverMode` (the switch does not dirty the draft).
  const opens = (serverMode: "simple" | "advanced") => {
    const mode = resolveEditorMode(serverMode, getEditorMode("card"), getGlobalEditorMode());
    if (mode === "simple") return "simple";
    return shouldOpenVisual({ mode, last: getEditorSurface(), allowed: true, guest: false }) ? "visual" : "classic";
  };
  try {
    // 简单模式 in the canvas's or 完整's ⋮ menu.
    rememberEditorChoice("card", "simple");
    assert.equal(opens("advanced"), "simple", "from the canvas or 完整 to simple");
    // 完整模式 in the simple editor's ⋮ menu, and the canvas's pill turned off.
    rememberEditorChoice("card", "classic");
    assert.equal(opens("simple"), "classic", "to 完整");
    assert.equal(opens("advanced"), "classic", "the canvas's pill off lands on 完整, not back on the canvas");
    // The pill turned on, from the simple editor.
    rememberEditorChoice("card", "visual");
    assert.equal(opens("simple"), "visual", "from simple to the canvas");
    // Simple leaves the surface alone: back to advanced later still opens
    // the surface they last used.
    rememberEditorChoice("card", "simple");
    assert.equal(getEditorSurface(), "visual");
    // The global fallback follows, so a card with no choice of its own opens
    // in the last-picked editor.
    assert.equal(getGlobalEditorMode(), "simple");
    assert.equal(getEditorMode("other-card"), null);
    rememberEditorChoice(null, "classic");
    assert.equal(getGlobalEditorMode(), "advanced");
    assert.equal(getEditorMode("card"), "simple", "a card without a server id records nothing per card");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
