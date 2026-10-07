import assert from "node:assert/strict";
import test from "node:test";
import type { UiDoc } from "@yumina/engine";
import { isVariableOnScreen } from "./variable-on-screen";

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
