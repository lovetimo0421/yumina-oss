import { describe, expect, it } from "vitest";
import { pageBehaviorRefs, pageVariableRefs, remapPageVariable, uiDocVariableRefs } from "../variable-refs.js";
import type { UiDoc } from "../types.js";

describe("uiDocVariableRefs", () => {
  it("names the variables a doc binds, reads apart from writes", () => {
    const doc = {
      pages: [{
        elements: [
          { kind: "meter", value: { kind: "variable", variableId: "trust" } },
          { kind: "text", text: { template: "At {{location}}, day {{ day }}" } },
          { kind: "button", onPress: [{ kind: "set-variable", variableId: "mood", op: "set", value: "calm" }] },
          { kind: "meter", value: { kind: "literal", value: 3 } },
        ],
      }],
    } as unknown as UiDoc;
    const refs = uiDocVariableRefs(doc);
    expect(refs.reads.sort()).toEqual(["day", "location", "trust"]);
    expect(refs.writes).toEqual(["mood"]);
  });
});

// A ready-made page comes with its own variables; the creator swaps one for
// theirs and every part of the page follows.
describe("remapPageVariable", () => {
  const doc = {
    version: 1,
    entryPageId: "a",
    pages: [
      { id: "a", name: "A", elements: [
        { id: "m", type: "meter", value: { kind: "variable", variableId: "love" } },
        { id: "t", type: "text", text: { template: "好感 {{love}} · {{ love }} · {{love.max}} · {{lovely}}" }, visibleWhen: { variableId: "love", operator: ">", value: 3 } },
        { id: "b", type: "button", requires: ["love", "name"], actions: [{ kind: "set-variable", variableId: "love", op: "add", value: 1 }] },
      ] },
      { id: "b", name: "B", elements: [{ id: "m2", type: "meter", value: { kind: "variable", variableId: "love" } }] },
    ],
  } as unknown as UiDoc;

  it("lists what the page uses", () => {
    expect(pageVariableRefs(doc, "a").sort()).toEqual(["love", "lovely", "name"]);
  });

  it("moves every use on that page and leaves the other page alone", () => {
    const next = remapPageVariable(doc, "a", "love", "affection");
    const [a, b] = next.pages;
    expect(JSON.stringify(a)).not.toMatch(/"love"|\{\{\s*love[\s}.]/);
    expect(a!.elements[1]).toMatchObject({ text: { template: "好感 {{affection}} · {{ affection }} · {{affection.max}} · {{lovely}}" }, visibleWhen: { variableId: "affection" } });
    expect(a!.elements[2]).toMatchObject({ requires: ["affection", "name"], actions: [{ variableId: "affection" }] });
    expect(b!.elements[0]).toMatchObject({ value: { variableId: "love" } });
  });
});

describe("pageBehaviorRefs", () => {
  it("lists the behaviours one page's buttons set off, once each, and not another page's", () => {
    const doc = {
      version: 1,
      pages: [
        { id: "a", name: "A", height: 812, elements: [
          { id: "b1", type: "button", actions: [{ kind: "run-behavior", actionId: "上楼" }, { kind: "go-page", pageId: "b" }] },
          { id: "b2", type: "button", actions: [{ kind: "run-behavior", actionId: "上楼" }, { kind: "run-behavior", actionId: "关门" }] },
        ] },
        { id: "b", name: "B", height: 812, elements: [{ id: "b3", type: "button", actions: [{ kind: "run-behavior", actionId: "离开" }] }] },
      ],
    } as unknown as UiDoc;
    expect(pageBehaviorRefs(doc, "a")).toEqual(["上楼", "关门"]);
    expect(pageBehaviorRefs(doc, "b")).toEqual(["离开"]);
    expect(pageBehaviorRefs(doc, "missing")).toEqual([]);
  });
});
