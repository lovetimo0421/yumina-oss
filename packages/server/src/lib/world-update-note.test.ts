import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_WORLD_UPDATE_CONTENT, MAX_WORLD_UPDATE_TITLE } from "@yumina/shared";
import { parseWorldUpdateNoteBody } from "./world-update-note.js";

test("world update notes trim authored text and default optional fields", () => {
  assert.deepEqual(
    parseWorldUpdateNoteBody({ title: "  Added chapter 3  ", content: "  New ending  " }),
    {
      ok: true,
      data: { title: "Added chapter 3", content: "New ending", isMajor: false },
    },
  );
  assert.deepEqual(
    parseWorldUpdateNoteBody({ title: "Small fix", content: "   ", isMajor: true }),
    { ok: true, data: { title: "Small fix", content: null, isMajor: true } },
  );
});

test("world update notes reject missing and oversized titles", () => {
  assert.deepEqual(parseWorldUpdateNoteBody({ title: "   " }), { ok: false, error: "Title is required" });
  const result = parseWorldUpdateNoteBody({ title: "x".repeat(MAX_WORLD_UPDATE_TITLE + 1) });
  assert.equal(result.ok, false);
});

test("world update notes reject oversized content and invalid field types", () => {
  assert.equal(
    parseWorldUpdateNoteBody({
      title: "Update",
      content: "x".repeat(MAX_WORLD_UPDATE_CONTENT + 1),
    }).ok,
    false,
  );
  assert.equal(parseWorldUpdateNoteBody({ title: "Update", content: 12 }).ok, false);
  assert.equal(parseWorldUpdateNoteBody({ title: "Update", isMajor: "yes" }).ok, false);
  assert.equal(parseWorldUpdateNoteBody(null).ok, false);
});
