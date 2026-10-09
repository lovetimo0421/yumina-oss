import assert from "node:assert/strict";
import test from "node:test";
import type { UiDoc } from "@yumina/engine";
import { isVariableOnScreen, removeVariableFromScreen } from "./variable-on-screen";

const doc = (elements: unknown[]) => ({ pages: [{ id: "p", elements }] }) as unknown as UiDoc;

test("a variable counts as on screen when a part is bound to it or prints it", () => {
  assert.equal(isVariableOnScreen(doc([{ id: "m", type: "meter", variableId: "affection" }]), "affection"), true);
  assert.equal(isVariableOnScreen(doc([{ id: "l", type: "list", source: { kind: "variable", variableId: "bag" } }]), "bag"), true);
  assert.equal(isVariableOnScreen(doc([{ id: "t", type: "text", text: "灵石：{{stones}}" }]), "stones"), true);
});

test("a variable nothing shows is not on screen", () => {
  assert.equal(isVariableOnScreen(undefined, "affection"), false);
  assert.equal(isVariableOnScreen(doc([{ id: "m", type: "meter", variableId: "affection-max" }]), "affection"), false);
  assert.equal(isVariableOnScreen(doc([{ id: "t", type: "text", text: "{{affection_old}}" }]), "affection"), false);
});

test("hiding a legacy display preserves actions, conditions, fields and mixed authored text", () => {
  const unrelated = [
    { id: "button", type: "button", actions: [{ kind: "set-variable", variableId: "bag" }] },
    { id: "field", type: "field", variableId: "bag" },
    { id: "image", type: "image", visibleWhen: { variableId: "bag" } },
    { id: "mixed", type: "text", text: { template: "{{bag}} / {{coins}}" } },
  ];
  const original = doc([...unrelated, { id: "list", type: "list", source: { kind: "variable", variableId: "bag" } }]);
  const next = removeVariableFromScreen(original, "bag");
  assert.deepEqual(next.pages[0].elements, unrelated);
  assert.equal(isVariableOnScreen(next, "bag"), false);
  assert.equal(original.pages[0].elements.length, 5);
  assert.equal(removeVariableFromScreen(next, "missing"), next);
});

test("removing a managed strip closes its gap on both widths without moving authored overlays", () => {
  const original: UiDoc = { version: 1, entryPageId: "p", base: { file: "_base.tsx" }, pages: [{
    id: "p", name: "Main", height: 812, elements: [
      { id: "one", type: "text", variableDisplay: "one", x: 16, y: 8, w: 343, h: 40, desktop: { x: 16, y: 8, w: 992, h: 40 }, text: { template: "{{one}}" } },
      { id: "two", type: "text", variableDisplay: "two", x: 16, y: 56, w: 343, h: 40, desktop: { x: 16, y: 56, w: 992, h: 40 }, text: { template: "{{two}}" } },
      { id: "custom", type: "text", x: 220, y: 600, w: 100, h: 40, text: { template: "Keep" } },
    ],
  }] };
  const next = removeVariableFromScreen(original, "one");
  assert.equal(next.pages[0].elements[0].y, 8);
  assert.equal(next.pages[0].elements[0].desktop?.y, 8);
  assert.deepEqual(next.pages[0].elements[1], original.pages[0].elements[2]);
});

test("display ownership follows actual bindings after rebinding or switching a list to static content", () => {
  const original = doc([
    { id: "meter", group: "g", type: "meter", variableDisplay: "old", value: { kind: "variable", variableId: "new" } },
    { id: "label", group: "g", type: "text", variableDisplay: "old", text: { template: "Health" } },
  ]);
  assert.equal(isVariableOnScreen(original, "old"), false);
  assert.equal(isVariableOnScreen(original, "new"), true);
  assert.equal(removeVariableFromScreen(original, "old"), original);
  assert.deepEqual(removeVariableFromScreen(original, "new").pages[0].elements, []);
  const staticList = doc([{ id: "list", type: "list", variableDisplay: "old", source: { kind: "static", items: ["Keep"] } }]);
  assert.equal(isVariableOnScreen(staticList, "old"), false);
  assert.equal(removeVariableFromScreen(staticList, "old"), staticList);
});
