import { test } from "node:test";
import assert from "node:assert/strict";
import type { UiDoc, UiElement, UiPage } from "@yumina/engine";
import { isDeadEnd } from "./page-strip";

const page = (id: string, elements: unknown[] = [], extra: Partial<UiPage> = {}) =>
  ({ id, name: id, height: 812, elements: elements as UiElement[], ...extra }) as UiPage;
const go = (pageId: string) => ({ id: `b-${pageId}`, type: "button", x: 0, y: 0, w: 10, h: 10, label: { template: "去" }, actions: [{ kind: "go-page", pageId }] });
const doc = (pages: UiPage[]) => ({ version: 1, pages, entryPageId: pages[0]!.id }) as unknown as UiDoc;

test("a page with no way to another page and no chat is a dead end", () => {
  const d = doc([page("a", [go("b")]), page("b", [{ id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, text: { template: "完" } }])]);
  assert.equal(isDeadEnd(d, d.pages[0]!), false);
  assert.equal(isDeadEnd(d, d.pages[1]!), true);
});

test("a chat, a timed leave, custom code or a lone page are not dead ends", () => {
  const chat = doc([page("a", [go("b")]), page("b", [{ id: "c", type: "composer", x: 0, y: 0, w: 10, h: 10 }])]);
  assert.equal(isDeadEnd(chat, chat.pages[1]!), false);
  const leaves = doc([page("a", [go("b")]), page("b", [], { leaveWhen: { when: {} as never, pageId: "a" } })]);
  assert.equal(isDeadEnd(leaves, leaves.pages[1]!), false);
  const custom = doc([page("a", [go("b")]), page("b", [{ id: "x", type: "custom", x: 0, y: 0, w: 10, h: 10 }])]);
  assert.equal(isDeadEnd(custom, custom.pages[1]!), false);
  const lone = doc([page("a")]);
  assert.equal(isDeadEnd(lone, lone.pages[0]!), false);
});

test("a button back to its own page, or to a page that is gone, is no way out", () => {
  const d = doc([page("a", [go("a"), go("missing")]), page("b", [go("a")])]);
  assert.equal(isDeadEnd(d, d.pages[0]!), true);
});
