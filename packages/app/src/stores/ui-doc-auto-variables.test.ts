import test from "node:test";
import assert from "node:assert/strict";
import type { UiDoc, UiElement, Variable, WorldDefinition } from "@yumina/engine";
import { autoRenameFor, reconcileAutoVariables, uniqueVariableName } from "./ui-doc-auto-variables";

const v = (id: string, name: string): Variable => ({ id, name, type: "string", defaultValue: "" });
const field = (id: string, variableId: string, label = "今晚的暗号是？"): UiElement => ({
  id, type: "field", kind: "text", variableId, label: { template: label }, x: 0, y: 0, w: 100, h: 40,
});
const doc = (elements: UiElement[], autoVariables?: string[]): UiDoc => ({
  version: 1, entryPageId: "p", pages: [{ id: "p", name: "p", height: 812, elements }],
  ...(autoVariables ? { autoVariables } : {}),
});
const world = (uiDoc: UiDoc | undefined, variables: Variable[], extra: Partial<WorldDefinition> = {}): WorldDefinition =>
  ({ variables, entries: [], rules: [], reactions: [], uiDoc, ...extra } as unknown as WorldDefinition);

test("a variable made for a part is adopted once a doc binds it", () => {
  const w = world(doc([]), [v("a", "今晚的暗号")]);
  const r = reconcileAutoVariables({ world: w, nextDoc: doc([field("f", "a")]), pending: ["a"] });
  assert.deepEqual(r.doc?.autoVariables, ["a"]);
  assert.deepEqual(r.stillPending, []);
  assert.equal(r.variables.length, 1);
});

test("it waits in pending until a part binds it", () => {
  const w = world(doc([]), [v("a", "x")]);
  const r = reconcileAutoVariables({ world: w, nextDoc: doc([]), pending: ["a"] });
  assert.deepEqual(r.stillPending, ["a"]);
  assert.equal(r.doc?.autoVariables, undefined);
});

test("deleting the part deletes its auto variable when nothing else reads it", () => {
  const before = doc([field("f", "a")], ["a"]);
  const w = world(before, [v("a", "今晚的暗号"), v("b", "名字")]);
  const r = reconcileAutoVariables({ world: w, nextDoc: doc([], ["a"]), pending: [] });
  assert.deepEqual(r.variables.map((x) => x.id), ["b"]);
  assert.equal(r.doc?.autoVariables, undefined);
});

test("re-binding the part to another variable deletes the orphan", () => {
  const w = world(doc([field("f", "a")], ["a"]), [v("a", "你的名字"), v("b", "接头暗号")]);
  const r = reconcileAutoVariables({ world: w, nextDoc: doc([field("f", "b")], ["a"]), pending: [] });
  assert.deepEqual(r.variables.map((x) => x.id), ["b"]);
});

test("a variable something else reads is kept", () => {
  const echo: UiElement = { id: "t", type: "text", text: { template: "暗号：{{a}}" }, x: 0, y: 0, w: 10, h: 10 };
  // Another part still reads it.
  let w = world(doc([field("f", "a"), echo], ["a"]), [v("a", "今晚的暗号")]);
  let r = reconcileAutoVariables({ world: w, nextDoc: doc([echo], ["a"]), pending: [] });
  assert.equal(r.variables.length, 1);
  assert.deepEqual(r.doc?.autoVariables, ["a"]);
  // A behaviour reads it.
  w = world(doc([field("f", "a")], ["a"]), [v("a", "今晚的暗号")], {
    reactions: [{ id: "r1", name: "check", when: { match: { variableId: { value: "a" } } } }] as unknown as WorldDefinition["reactions"],
  });
  r = reconcileAutoVariables({ world: w, nextDoc: doc([], ["a"]), pending: [] });
  assert.equal(r.variables.length, 1);
});

test("a cut keeps the variable (the part is coming back)", () => {
  const w = world(doc([field("f", "a")], ["a"]), [v("a", "今晚的暗号")]);
  const r = reconcileAutoVariables({ world: w, nextDoc: doc([], ["a"]), pending: [], keep: true });
  assert.equal(r.variables.length, 1);
});

test("a variable the creator made is never removed", () => {
  const w = world(doc([field("f", "mine")]), [v("mine", "我的变量")]);
  const r = reconcileAutoVariables({ world: w, nextDoc: doc([]), pending: [] });
  assert.equal(r.variables.length, 1);
});

test("names are unique", () => {
  const vars = [v("a", "你的名字"), v("b", "你的名字 2")];
  assert.equal(uniqueVariableName("你的名字", vars), "你的名字 3");
  assert.equal(uniqueVariableName("你的名字", vars, "a"), "你的名字");
});

test("an auto variable follows its question while the name is still the editor's", () => {
  const d = doc([field("f", "a", "你的名字是？")], ["a"]);
  const w = world(d, [v("a", "你的名字")]);
  assert.equal(autoRenameFor({ world: w, variableId: "a", oldText: "你的名字是？", newText: "今晚的暗号是？", fallback: "名字" }), "今晚的暗号");
  // Renamed by hand: left alone.
  const renamed = world(d, [v("a", "接头暗号")]);
  assert.equal(autoRenameFor({ world: renamed, variableId: "a", oldText: "你的名字是？", newText: "今晚的暗号是？", fallback: "名字" }), null);
  // Not an auto variable: left alone.
  const own = world(doc([field("f", "a", "你的名字是？")]), [v("a", "你的名字")]);
  assert.equal(autoRenameFor({ world: own, variableId: "a", oldText: "你的名字是？", newText: "今晚的暗号是？", fallback: "名字" }), null);
  // Read by a second part: left alone.
  const echo: UiElement = { id: "t", type: "text", text: { template: "{{a}}" }, x: 0, y: 0, w: 10, h: 10 };
  const shared = world(doc([field("f", "a", "你的名字是？"), echo], ["a"]), [v("a", "你的名字")]);
  assert.equal(autoRenameFor({ world: shared, variableId: "a", oldText: "你的名字是？", newText: "今晚的暗号是？", fallback: "名字" }), null);
  // A de-duplicated name ("你的名字 2") still counts as the editor's.
  const second = world(d, [v("x", "今晚的暗号"), v("a", "你的名字 2")]);
  assert.equal(autoRenameFor({ world: second, variableId: "a", oldText: "你的名字是？", newText: "今晚的暗号是？", fallback: "名字" }), "今晚的暗号 2");
});
