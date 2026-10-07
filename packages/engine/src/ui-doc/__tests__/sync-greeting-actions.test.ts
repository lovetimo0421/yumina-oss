import { describe, expect, it } from "vitest";
import { syncGreetingActions } from "../edit.js";
import type { UiDoc } from "../types.js";

function docWith(actions: Array<{ index: number; greetingId?: string }>): UiDoc {
  return {
    version: 1,
    entryPageId: "p",
    pages: [{
      id: "p", name: "P", height: 812,
      elements: [{
        id: "c", type: "choice", name: "C", x: 0, y: 0, w: 100, h: 100,
        options: actions.map((a, i) => ({ id: `o${i}`, title: `o${i}`, actions: [{ kind: "switch-greeting", ...a }] })),
      }],
    }],
  } as unknown as UiDoc;
}

const indexes = (doc: UiDoc) =>
  (doc.pages[0]!.elements[0] as unknown as { options: Array<{ actions: Array<{ index: number }> }> })
    .options.map((o) => o.actions[0]!.index);

describe("syncGreetingActions", () => {
  it("recounts steps by the opening they name", () => {
    const doc = docWith([{ index: 0, greetingId: "a" }, { index: 1, greetingId: "b" }, { index: 2, greetingId: "c" }]);
    expect(indexes(syncGreetingActions(doc, ["c", "a", "b"]))).toEqual([1, 2, 0]);
  });

  it("follows an opening when an earlier one is removed", () => {
    const doc = docWith([{ index: 0, greetingId: "a" }, { index: 1, greetingId: "b" }]);
    expect(indexes(syncGreetingActions(doc, ["b"]))).toEqual([0, 0]);
  });

  it("leaves steps without an id, and returns the same doc when nothing moved", () => {
    const doc = docWith([{ index: 1 }, { index: 0, greetingId: "a" }]);
    expect(syncGreetingActions(doc, ["a", "b"])).toBe(doc);
  });
});
