import test from "node:test";
import assert from "node:assert/strict";
import { changeLabel } from "./change-label.js";

test("maps an added entry to opAdded with kind + name values", () => {
  assert.deepEqual(
    changeLabel({ kind: "entry", op: "added", id: "e1", name: "铃花" }),
    { i18nKey: "studio.changeLog.opAdded", kindKey: "studio.changeLog.kind.entry", name: "铃花", tone: "added" },
  );
});

test("maps a removed variable to opRemoved with removed tone", () => {
  const r = changeLabel({ kind: "variable", op: "removed", id: "v1", name: "夜晚" });
  assert.equal(r.i18nKey, "studio.changeLog.opRemoved");
  assert.equal(r.tone, "removed");
});

test("maps a modified rule to opModified with modified tone", () => {
  assert.equal(changeLabel({ kind: "rule", op: "modified", id: "r1", name: "r1" }).tone, "modified");
});
