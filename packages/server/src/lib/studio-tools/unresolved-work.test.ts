import assert from "node:assert/strict";
import { test } from "node:test";
import { UnresolvedWork } from "./unresolved-work.js";

test("a failed write stays listed until a write to the same id lands", () => {
  const work = new UnresolvedWork();
  assert.equal(work.note(), null);
  work.recordWrite("write_entry", "tavern", false, "Entry content must be a string.\nmore detail");
  const note = work.note()!;
  assert.match(note, /write_entry "tavern" failed and was not redone: Entry content must be a string\./);
  assert.doesNotMatch(note, /more detail/);
  assert.match(note, /Do not describe the task as done/);
  // Unchanged list: not repeated.
  assert.equal(work.note(), null);
  work.recordWrite("edit_custom_ui", "tavern", true);
  assert.equal(work.note(), null);
});

test("validation errors are listed, capped, and cleared by a clean check", () => {
  const work = new UnresolvedWork();
  work.recordValidation(Array.from({ length: 8 }, (_, i) => ({ code: "c", message: `problem ${i}` })));
  const note = work.note()!;
  assert.match(note, /problem 5/);
  assert.doesNotMatch(note, /problem 6/);
  assert.match(note, /\+2 more/);
  work.recordValidation([]);
  assert.equal(work.note(), null);
  // Coming back after being cleared is news again.
  work.recordValidation([{ code: "c", message: "problem 0" }]);
  assert.match(work.note()!, /problem 0/);
});

test("an interface change is listed as not seen, apart from failures", () => {
  const work = new UnresolvedWork();
  work.recordUnseenUi("index.tsx");
  const note = work.note()!;
  assert.match(note, /Not seen yet: you changed the interface \(index\.tsx\)/);
  assert.match(note, /never that it looks good/);
  assert.doesNotMatch(note, /Still not done/);
  work.recordUnseenUi("index.tsx");
  assert.equal(work.note(), null, "the same file again is not news");
  work.recordWrite("write_entry", "lore", false, "bad");
  const both = work.note()!;
  assert.ok(both.indexOf("Still not done") < both.indexOf("Not seen yet"));
});
