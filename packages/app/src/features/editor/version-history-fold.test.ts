import test from "node:test";
import assert from "node:assert/strict";
import type { WorldVersion } from "@yumina/shared";
import { foldAutosaves } from "./version-history-fold";

const v = (id: string, source: string): WorldVersion =>
  ({ id, worldId: "w", createdBy: "u", name: id, note: null, source, createdAt: new Date() });

test("a run of autosave points folds into one row; anything else stands alone and ends the run", () => {
  const items = foldAutosaves([v("a1", "autosave"), v("a2", "autosave"), v("p", "publish"), v("a3", "autosave"), v("b", "backup"), v("a4", "autosave"), v("a5", "autosave"), v("a6", "autosave")]);
  assert.deepEqual(items.map((i) => i.kind === "version" ? i.version.id : i.versions.map((x) => x.id).join("+")),
    ["a1+a2", "p", "a3", "b", "a4+a5+a6"]);
});

test("no autosaves, nothing folded", () => {
  assert.deepEqual(foldAutosaves([v("p", "publish"), v("l", "live")]).map((i) => i.kind), ["version", "version"]);
  assert.deepEqual(foldAutosaves([]), []);
});
