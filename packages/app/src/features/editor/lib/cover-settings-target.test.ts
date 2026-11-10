import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { coverSettingsNavigation, coverSettingsSearch, focusCoverInStudio, focusCoverSettings, STUDIO_FOCUS_COVER_EVENT, type StudioFocusCoverDetail } from "./cover-settings-target";

test("cover deep links accept only the two existing artwork targets", () => {
  for (const cover of [undefined, null, [], {}, "overview", "", "landscape\" onclick=\"bad"]) {
    assert.deepEqual(coverSettingsSearch({ cover }), {});
  }
  assert.deepEqual(coverSettingsSearch({ cover: "landscape", unrelated: "ignored" }), { cover: "landscape" });
  assert.deepEqual(coverSettingsSearch({ cover: "portrait" }), { cover: "portrait" });
});

test("repeat shortcuts preserve the chosen version and create a fresh focus request", () => {
  const first = coverSettingsNavigation("selected-language-variant", "landscape");
  const second = coverSettingsNavigation("selected-language-variant", "landscape");
  assert.deepEqual(first.params, { worldId: "selected-language-variant" });
  assert.deepEqual(first.search, { cover: "landscape" });
  assert.notDeepEqual(first.state, second.state, "same-URL navigation must not be deduplicated by the router");
});

test("an open canvas on the same card takes the cover shortcut; otherwise it goes to /edit", () => {
  const dom = new JSDOM("");
  const originalWindow = globalThis.window;
  const originalEvent = globalThis.CustomEvent;
  Object.assign(globalThis, { window: dom.window, CustomEvent: dom.window.CustomEvent });
  try {
    assert.equal(focusCoverInStudio("card", "portrait"), false, "nothing listening (classic editor, phone studio)");
    const asked: StudioFocusCoverDetail[] = [];
    dom.window.addEventListener(STUDIO_FOCUS_COVER_EVENT, (event) => {
      const detail = (event as CustomEvent<StudioFocusCoverDetail>).detail;
      asked.push(detail);
      if (detail.worldId === "card") event.preventDefault();
    });
    assert.equal(focusCoverInStudio("card", "landscape"), true);
    assert.equal(focusCoverInStudio("another-card", "portrait"), false, "a canvas on another card leaves it to /edit");
    assert.deepEqual(asked, [{ worldId: "card", cover: "landscape" }, { worldId: "another-card", cover: "portrait" }]);
  } finally {
    Object.assign(globalThis, { window: originalWindow, CustomEvent: originalEvent });
    dom.window.close();
  }
});

test("a cover shortcut reveals and focuses its own upload control without opening a picker", async () => {
  const dom = new JSDOM(`<div id="settings"><input id="name" value="Unsaved name">
    <section data-cover-shape="portrait"><button data-cover-upload>Upload portrait</button></section>
    <section data-cover-shape="landscape"><button data-cover-upload>Upload landscape</button></section></div>`, { pretendToBeVisual: true });
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  const root = dom.window.document.getElementById("settings")!;
  const scrolled: string[] = [];
  let pickerOpens = 0;
  for (const section of root.querySelectorAll<HTMLElement>("section")) {
    section.scrollIntoView = () => { scrolled.push(section.dataset.coverShape!); };
    section.querySelector("button")!.addEventListener("click", () => { pickerOpens++; });
  }
  let cleanup = () => {};
  try {
    for (const target of ["landscape", "portrait"] as const) {
      cleanup = focusCoverSettings(root, target);
      await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
      assert.equal(dom.window.document.activeElement, root.querySelector(`[data-cover-shape="${target}"] button`));
      assert.equal(root.querySelector('[data-cover-focus="true"]')?.getAttribute("data-cover-shape"), target);
      assert.equal((root.querySelector("#name") as HTMLInputElement).value, "Unsaved name");
      assert.equal(pickerOpens, 0);
      cleanup();
      assert.equal(root.querySelector("[data-cover-focus]"), null);
    }
    assert.deepEqual(scrolled, ["landscape", "portrait"]);
    cleanup = focusCoverSettings(root, "landscape");
    cleanup();
    await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
    assert.deepEqual(scrolled, ["landscape", "portrait"], "leaving before the next frame cancels the jump");
  } finally {
    cleanup();
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
    dom.window.close();
  }
});
