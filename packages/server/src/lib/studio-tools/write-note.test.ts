import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { WorldDefinition } from "@yumina/engine";
import { applyNoteChange } from "./tool-executor.js";

const world = () => ({ id: "w", name: "w", entries: [], variables: [], graphLayout: { version: 1, nodes: {}, notes: [{ id: "n1", x: 5, y: 5, w: 200, h: 44, text: "keep me", targets: ["var:hp"] }] } }) as unknown as WorldDefinition;

test("write_note makes a note stuck to one thing, replaces its text, and peels it off with \"\"", () => {
  const w = world();
  assert.equal(applyNoteChange(w, { on: "ai:code:index.tsx:12", text: "Judges each line." }, 0).status, "success");
  const made = w.graphLayout!.notes!.find((n) => n.targets?.[0] === "ai:code:index.tsx:12");
  assert.equal(made?.text, "Judges each line.");
  applyNoteChange(w, { on: "ai:code:index.tsx:12", text: "Judges each line and sets suspicion." }, 0);
  assert.equal(w.graphLayout!.notes!.filter((n) => n.targets?.[0] === "ai:code:index.tsx:12").length, 1, "the same note, not a second");
  assert.equal(w.graphLayout!.notes!.find((n) => n.targets?.[0] === "ai:code:index.tsx:12")?.text, "Judges each line and sets suspicion.");
  applyNoteChange(w, { on: "ai:code:index.tsx:12", text: "" }, 0);
  assert.equal(w.graphLayout!.notes!.some((n) => n.targets?.[0] === "ai:code:index.tsx:12"), false);
  assert.equal(w.graphLayout!.notes!.find((n) => n.id === "n1")?.text, "keep me", "other notes untouched");
  assert.equal(applyNoteChange(w, { on: "", text: "x" }, 0).status, "error");
});
