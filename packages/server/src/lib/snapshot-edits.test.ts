import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffWorld, migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { revertRecordedSteps } from "./snapshot-edits.js";

type Json = Record<string, unknown>;
const entry = (id: string, name: string, content: string) => ({ id, name, content, section: "system-presets", enabled: true, position: 0 });
const card = (entries: unknown[], extra: Json = {}): Json => ({ id: "t", version: "1", name: "Card", description: "", entries, variables: [], rules: [], ...extra });
const edits = (a: Json, b: Json) => diffWorld(migrateWorldDefinition(a as unknown as WorldDefinition), migrateWorldDefinition(b as unknown as WorldDefinition));
const content = (w: Json, id: string) => (w.entries as Array<{ id: string; content: string; name: string }>).find((e) => e.id === id);

describe("rolling back an assistant's steps", () => {
  it("undoes only what the steps changed, keeping a collaborator's edits made meanwhile", () => {
    const before = card([entry("a", "A", "original"), entry("b", "B", "b text")]);
    const afterStep = card([entry("a", "A", "assistant rewrote this"), entry("b", "B", "b text"), entry("c", "C", "assistant added")]);
    // Meanwhile a collaborator edited another entry and the description.
    const current = card([entry("a", "A", "assistant rewrote this"), entry("b", "B", "collaborator text"), entry("c", "C", "assistant added")], { description: "theirs" });

    const result = revertRecordedSteps(before, [edits(before, afterStep)], current)!;
    assert.equal(content(result.schema, "a")?.content, "original", "the assistant's rewrite is undone");
    assert.equal(content(result.schema, "c"), undefined, "the assistant's new entry is removed");
    assert.equal(content(result.schema, "b")?.content, "collaborator text", "the collaborator's edit stays");
    assert.equal(result.schema.description, "theirs");
    assert.deepEqual(result.kept, []);
  });

  it("keeps a later change to something the step touched, and says so", () => {
    const before = card([entry("a", "A", "original")]);
    const afterStep = card([entry("a", "A", "assistant text")]);
    const current = card([entry("a", "A", "someone fixed the assistant text")]);
    const result = revertRecordedSteps(before, [edits(before, afterStep)], current)!;
    assert.equal(content(result.schema, "a")?.content, "someone fixed the assistant text");
    assert.deepEqual(result.kept, [{ collection: "entries", id: "a" }]);
  });

  it("undoes a chain of steps in order", () => {
    const s0 = card([entry("a", "A", "v0")]);
    const s1 = card([entry("a", "A", "v1")]);
    const s2 = card([entry("a", "A2", "v2")]);
    const result = revertRecordedSteps(s0, [edits(s0, s1), edits(s1, s2)], s2)!;
    assert.deepEqual([content(result.schema, "a")?.name, content(result.schema, "a")?.content], ["A", "v0"]);
  });

  it("records each write's own change, so an editor save merged mid-step survives the rollback", () => {
    const before = card([entry("a", "A", "a0"), entry("b", "B", "b0")]);
    const write1 = card([entry("a", "A", "assistant 1"), entry("b", "B", "b0")]);
    // An editor saved entry b while the step ran; the step continued from the merge.
    const merged = card([entry("a", "A", "assistant 1"), entry("b", "B", "editor")]);
    const write2 = card([entry("a", "A", "assistant 2"), entry("b", "B", "editor")]);
    const recorded = [...edits(before, write1), ...edits(merged, write2)];
    const result = revertRecordedSteps(before, [recorded], write2)!;
    assert.equal(content(result.schema, "a")?.content, "a0");
    assert.equal(content(result.schema, "b")?.content, "editor", "the editor's save is not the assistant's to undo");
    assert.deepEqual(result.kept, []);
  });

  it("keeps rows others added where they put them", () => {
    const before = card([entry("a", "A", "a0"), entry("b", "B", "b0")]);
    const afterStep = card([entry("a", "A", "assistant"), entry("b", "B", "b0")]);
    const current = card([entry("h", "H", "theirs"), entry("a", "A", "assistant"), entry("b", "B", "b0")]);
    const result = revertRecordedSteps(before, [edits(before, afterStep)], current)!;
    assert.deepEqual((result.schema.entries as Array<{ id: string }>).map((e) => e.id), ["h", "a", "b"]);
    assert.equal(content(result.schema, "a")?.content, "a0");
  });

  it("puts back a deleted row behind its old neighbour, and undoes the step's reorder", () => {
    const before = card([entry("a", "A", "a"), entry("b", "B", "b"), entry("c", "C", "c")]);
    const afterStep = card([entry("c", "C", "c"), entry("a", "A", "a")]);
    const current = card([entry("c", "C", "c"), entry("a", "A", "a"), entry("h", "H", "theirs")]);
    const result = revertRecordedSteps(before, [edits(before, afterStep)], current)!;
    assert.deepEqual((result.schema.entries as Array<{ id: string }>).map((e) => e.id), ["a", "h", "b", "c"]);
  });

  it("refuses malformed records rather than guessing", () => {
    assert.equal(revertRecordedSteps(card([]), [[{ op: "nope" }]], card([])), null);
  });
});
