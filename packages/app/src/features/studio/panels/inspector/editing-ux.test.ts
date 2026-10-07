import test from "node:test";
import assert from "node:assert/strict";
import { getUiStarter } from "@yumina/engine";
import type { UiDoc } from "@yumina/engine";
import { phoneFitFor } from "./phone-fit";
import { offCanvasCount, presenceBadgeKey, selectAllOnPage } from "./selection-units";
import { gripSizes } from "./drag-handles";
import { isThemeFontValue } from "./font-value";
import { needsLayoutConfirm } from "../blueprint/look-actions";

const starter = (id: string): UiDoc => getUiStarter(id)!.build({ strings: {} });

test("the phone canvas fits the box on a monitor and takes the width on a phone", () => {
  // A tall desktop column: fit it (null = the default fit-in-box layout).
  assert.equal(phoneFitFor(600, 780), null);
  // A 358-wide phone column with ~300px left: full width, the stage scrolls.
  assert.deepEqual(phoneFitFor(358, 300), { width: 358, height: Math.round((358 * 812) / 375) });
  // Never wider than a phone.
  assert.equal(phoneFitFor(900, 300)!.width, 390);
  // Readable when squeezed to height (>= 0.7): still fit.
  assert.equal(phoneFitFor(358, 700), null);
  assert.equal(phoneFitFor(0, 0), null);
});

test("Ctrl+A picks every part on the page, the ones drawn here first", () => {
  const form = starter("character-setup").pages.find((p) => p.id === "form")!;
  const onPhone = selectAllOnPage(form, "phone");
  // The desktop-only register card is included — but after the phone's own parts.
  assert.ok(onPhone.includes("form-register"));
  assert.ok(onPhone.indexOf("form-register") > onPhone.indexOf("form-title"));
  assert.equal(offCanvasCount(form, onPhone, "phone") > 0, true);
  assert.equal(offCanvasCount(form, ["form-title"], "phone"), 0);
  // Load-bearing parts are never picked.
  const chat = starter("character-setup").pages.find((p) => p.id === "chat")!;
  for (const id of selectAllOnPage(chat, "desktop")) {
    const el = chat.elements.find((e) => e.id === id)!;
    assert.ok(!["chat", "messages", "composer"].includes(el.type));
  }
});

test("layers badges say where a one-canvas part lives", () => {
  const form = starter("character-setup").pages.find((p) => p.id === "form")!;
  assert.equal(presenceBadgeKey(form.elements.filter((e) => e.id === "form-register")), "studio.canvasEdit.onlyDesktop");
  const collection = starter("collection").pages.flatMap((p) => p.elements);
  assert.equal(presenceBadgeKey(collection.filter((e) => e.desktop === null).slice(0, 1)), "studio.canvasEdit.onlyPhone");
  assert.equal(presenceBadgeKey(form.elements.filter((e) => e.id === "form-title")), null);
});

test("touch grips are at least 24px to hit", () => {
  assert.ok(gripSizes(true).hit >= 24);
  assert.equal(gripSizes(false).hit, 8);
});

test("a var() font reads as 跟着主题, not as code", () => {
  assert.equal(isThemeFontValue("var(--yc-font, inherit)"), true);
  assert.equal(isThemeFontValue(undefined), true);
  assert.equal(isThemeFontValue("\"Noto Serif SC\", serif"), false);
});

test("a layout switch asks only when there is an interface to lose", () => {
  assert.equal(needsLayoutConfirm(undefined, "portrait-scene"), false);
  const bare: UiDoc = { version: 1, entryPageId: "p", surface: "chat", pages: [{ id: "p", name: "p", height: 812, elements: [] }] };
  assert.equal(needsLayoutConfirm(bare, "portrait-scene"), false);
  assert.equal(needsLayoutConfirm(starter("openings"), "portrait-scene"), true);
  assert.equal(needsLayoutConfirm(starter("openings"), null), true);
});
