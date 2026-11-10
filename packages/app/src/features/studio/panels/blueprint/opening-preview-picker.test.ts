import assert from "node:assert/strict";
import test from "node:test";
import type { WorldEntry } from "@yumina/engine";
import { resolvePreviewOpening } from "@/features/editor/components/preview/preview-opening";

const opening = (id: string, extra: Partial<WorldEntry> = {}): WorldEntry => ({
  id, name: id, content: `Opening ${id}`, role: "greeting", section: "chat-history",
  position: 0, enabled: true, alwaysSend: false, keywords: [], conditions: [], conditionLogic: "all", ...extra,
});

test("previewing the second opening preserves stored order, enabled flags and initial values", () => {
  const first = opening("town", { initialVariables: { hp: 100 } });
  const second = opening("mine", { initialVariables: { hp: 30 } });
  const entries = [first, opening("setting", { role: "custom" }), second];
  const before = structuredClone(entries);
  Object.freeze(entries);
  entries.forEach(Object.freeze);

  assert.equal(resolvePreviewOpening(entries, "mine"), second);
  assert.deepEqual(entries, before);
  assert.equal(resolvePreviewOpening(entries), first, "preview selection does not become the saved default");
});

test("deleting the selected opening falls back to the first enabled opening", () => {
  const next = opening("harbor");
  const entries = [opening("draft", { enabled: false }), opening("mine"), next];
  const remaining = entries.filter(entry => entry.id !== "mine");

  assert.equal(resolvePreviewOpening(remaining, "mine"), next);
  assert.deepEqual(remaining.map(entry => entry.id), ["draft", "harbor"]);
});

test("default preview follows authored opening positions without sorting the source array", () => {
  const later = opening("later", { position: 9 });
  const first = opening("first", { position: 1 });
  const entries = [later, first];
  assert.equal(resolvePreviewOpening(entries), first);
  assert.deepEqual(entries, [later, first]);
});

test("an explicitly selected disabled opening can be previewed without enabling it", () => {
  const draft = opening("unreleased", { enabled: false });
  const entries = [opening("published"), draft];

  assert.equal(resolvePreviewOpening(entries, draft.id), draft);
  assert.equal(draft.enabled, false);
  assert.equal(resolvePreviewOpening(entries)?.id, "published");
});

test("when all openings are disabled, a stale selection resolves to an existing opening", () => {
  const first = opening("town", { enabled: false });
  const second = opening("mine", { enabled: false });
  const entries = [first, second];

  assert.equal(resolvePreviewOpening(entries, "deleted"), first);
  assert.equal(resolvePreviewOpening(entries, "mine"), second);
  assert.equal(resolvePreviewOpening(entries), first);
  assert.ok(entries.every(entry => !entry.enabled));
});

test("empty cards and IDs that now belong to a setting cannot leave a dangling preview selection", () => {
  assert.equal(resolvePreviewOpening([], "deleted"), undefined);
  const setting = opening("changed-role", { role: "custom" });
  assert.equal(resolvePreviewOpening([setting], "changed-role"), undefined);
  const fallback = opening("town");
  assert.equal(resolvePreviewOpening([setting, fallback], "changed-role"), fallback);
});
