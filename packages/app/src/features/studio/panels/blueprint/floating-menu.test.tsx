import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, useState } from "react";
import { JSDOM } from "jsdom";
import { BlueprintFloatingMenu, blueprintMenuAnchor } from "./floating-menu";

test("keyboard menus anchor to their trigger, focus and navigate items, and restore focus only when dismissed with Escape", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  class ResizeObserverStub { observe() {} disconnect() {} }
  const globals = { window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, ResizeObserver: ResizeObserverStub, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(dom.window, "innerWidth", { value: 780 });
  Object.defineProperty(dom.window, "innerHeight", { value: 520 });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.hasAttribute("data-blueprint-context-menu") ? new dom.window.DOMRect(0, 0, 190, 160) : new dom.window.DOMRect(620, 420, 32, 32);
  };
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  function Harness() {
    const [menu, setMenu] = useState<ReturnType<typeof blueprintMenuAnchor> | null>(null);
    return createElement("div", null,
      createElement("button", { "data-trigger": true, onClick: event => setMenu(blueprintMenuAnchor(event, { left: 100, top: 60 })) }, "More"),
      createElement("input", { "data-destination": true }),
      menu && createElement(BlueprintFloatingMenu, { x: menu.x + 100, y: menu.y + 60, keyboardTrigger: menu.keyboardTrigger, onEscape: () => setMenu(null), children: [
        createElement("button", { key: "disabled", disabled: true }, "Unavailable"),
        createElement("button", { key: "open", "data-open": true, onClick: () => { setMenu(null); container.querySelector<HTMLInputElement>("[data-destination]")!.focus(); } }, "Open editor"),
        createElement("button", { key: "copy", "data-copy": true }, "Duplicate"),
      ] }),
    );
  }
  const click = async (element: Element, detail = 0, clientX = 0, clientY = 0) => { await act(async () => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail, clientX, clientY }))); };
  const key = async (value: string) => { await act(async () => dom.window.document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: value }))); };
  const floating = () => dom.window.document.querySelector<HTMLElement>("[data-blueprint-context-menu]")!;
  try {
    await act(async () => root.render(createElement(Harness)));
    const trigger = container.querySelector<HTMLButtonElement>("[data-trigger]")!;
    trigger.focus();
    await click(trigger);
    assert.equal(floating().parentElement, dom.window.document.body, "the actual menu crosses the canvas via its body portal");
    assert.equal(floating().style.left, "582px", "keyboard anchor is the trigger, constrained within the right viewport edge");
    assert.equal(floating().style.top, "352px", "the full menu stays above the viewport bottom");
    assert.equal(dom.window.document.activeElement, floating().querySelector("[data-open]"), "keyboard opening focuses the first enabled item");
    await key("ArrowDown");
    assert.equal(dom.window.document.activeElement, floating().querySelector("[data-copy]"));
    await key("Home");
    assert.equal(dom.window.document.activeElement, floating().querySelector("[data-open]"));
    await key("Escape");
    assert.equal(floating(), null);
    assert.equal(dom.window.document.activeElement, trigger);

    await click(trigger);
    await click(floating().querySelector("[data-open]")!, 1);
    assert.equal(floating(), null);
    assert.equal(dom.window.document.activeElement, container.querySelector("[data-destination]"), "an action's destination keeps focus after the menu unmounts");

    trigger.focus();
    await click(trigger, 1, 500, 300);
    assert.equal(floating().style.left, "500px");
    assert.equal(floating().style.top, "300px");
    assert.equal(dom.window.document.activeElement, trigger, "mouse opening preserves pointer-based behavior");
    await key("Escape");
    assert.equal(floating(), null);
    const mouseContext = blueprintMenuAnchor({ type: "contextmenu", detail: 0, clientX: 500, clientY: 300, currentTarget: trigger }, { left: 100, top: 60 });
    assert.deepEqual(mouseContext, { x: 400, y: 240 }, "native mouse context menus may have detail zero but still use pointer coordinates");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
