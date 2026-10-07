import test from "node:test";
import assert from "node:assert/strict";
import { getUiStarter, setEntryPage, type UiDoc } from "@yumina/engine";
import { pageLeaveHint } from "./page-leave-hint";

const openings = (): UiDoc => getUiStarter("openings")!.build({ strings: {} });
const page = (doc: UiDoc, id: string) => doc.pages.find((p) => p.id === id)!;

test("the first page says it switches once the chat starts", () => {
  const doc = openings();
  const hint = pageLeaveHint(doc, page(doc, "open"), []);
  assert.equal(hint?.key, "leavesTo");
  assert.equal(hint?.target.id, "chat");
});

test("an old opening page that nothing leads to says nothing once another page is first", () => {
  const doc = setEntryPage(openings(), "chat");
  assert.equal(pageLeaveHint(doc, page(doc, "open"), []), null);
});

test("a page a button leads to says it only switches while the player is on it", () => {
  const base = setEntryPage(openings(), "chat");
  const doc: UiDoc = {
    ...base,
    pages: base.pages.map((p) => p.id !== "chat" ? p : {
      ...p,
      elements: [...p.elements, {
        id: "back", type: "button", x: 0, y: 0, w: 100, h: 40,
        label: { template: "Back" }, actions: [{ kind: "go-page", pageId: "open" }],
      }],
    }),
  };
  assert.equal(pageLeaveHint(doc, page(doc, "open"), [])?.key, "leavesToHere");
});

test("a variable condition names the variable, not its id", () => {
  const base = openings();
  const doc: UiDoc = {
    ...base,
    pages: base.pages.map((p) => p.id !== "open" ? p : {
      ...p, leaveWhen: { when: { variableId: "var-gold", operator: "gte", value: 10 }, pageId: "chat" },
    }),
  };
  const hint = pageLeaveHint(doc, page(doc, "open"), [{ id: "var-gold", name: "金币" }]);
  assert.equal(hint?.key, "leavesToWhen");
  assert.equal(hint?.variableName, "金币");
});
