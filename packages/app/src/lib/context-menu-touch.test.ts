import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createContextMenuTouchGuard, keepMenuInViewport, viewportMenuShift } from "./context-menu-touch";

test("touch guard blocks early and late native selection without blocking Radix contextmenu", () => {
  const dom = new JSDOM("<p>Outside the asset tile</p>");
  const doc = dom.window.document;
  const guard = createContextMenuTouchGuard();
  const select = () => {
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector("p")!);
    doc.getSelection()!.addRange(range);
  };
  select();
  guard.start(doc);
  assert.equal(doc.getSelection()!.rangeCount, 0);
  assert.equal(doc.querySelectorAll("style").length, 1);
  assert.equal(doc.dispatchEvent(new dom.window.Event("selectstart", { cancelable: true })), false);
  assert.equal(doc.dispatchEvent(new dom.window.Event("contextmenu", { cancelable: true })), true);
  guard.setOpen(true);
  doc.dispatchEvent(new dom.window.Event("pointerup"));
  select();
  doc.dispatchEvent(new dom.window.Event("selectionchange"));
  assert.equal(doc.getSelection()!.rangeCount, 0, "lock survives finger release and portal selection migration");
  guard.setOpen(false);
  assert.equal(doc.querySelectorAll("style").length, 0);
  select();
  doc.dispatchEvent(new dom.window.Event("selectionchange"));
  assert.equal(doc.getSelection()!.rangeCount, 1, "rename selection is restored after dismissal");
  guard.dispose();
  dom.window.close();
});

test("scroll, cancelled touches, ordinary taps and unmount release the document lock", () => {
  const dom = new JSDOM();
  for (const type of ["pointermove", "pointercancel", "pointerup"]) {
    const guard = createContextMenuTouchGuard();
    guard.start(dom.window.document);
    dom.window.document.dispatchEvent(new dom.window.Event(type));
    assert.equal(dom.window.document.querySelectorAll("style").length, 0, type);
    guard.dispose();
  }
  const first = createContextMenuTouchGuard();
  const second = createContextMenuTouchGuard();
  first.start(dom.window.document);
  second.start(dom.window.document);
  first.dispose();
  first.dispose();
  assert.equal(dom.window.document.querySelectorAll("style").length, 1, "independent menu locks don't remove each other");
  second.dispose();
  assert.equal(dom.window.document.querySelectorAll("style").length, 0);
  dom.window.close();
});

test("wide submenus overlap their parent instead of leaving either phone edge", () => {
  for (const viewport of [320, 375, 390, 430, 768]) {
    for (const width of [128, 200, viewport - 16]) {
      for (const left of [-width + 23, 23, viewport / 2, viewport - 23]) {
        const shifted = left + viewportMenuShift(left, width, 0, viewport);
        assert.ok(shifted >= 8 && shifted + width <= viewport - 8);
      }
    }
  }
  assert.equal(viewportMenuShift(50, 200, 0, 390), 0, "desktop/sufficient-space placement stays unchanged");
  assert.equal(viewportMenuShift(10, 128, 100, 320), 98, "visual viewport offset after zoom");
});

test("submenu corrects new Radix placements without accumulating translation and removes observers", () => {
  const dom = new JSDOM("<div><div id='menu'></div></div>");
  const win = dom.window;
  Object.defineProperty(win, "innerWidth", { value: 320, configurable: true });
  let resized: (() => void) | undefined;
  let moved: (() => void) | undefined;
  let disconnected = 0;
  win.ResizeObserver = class { constructor(cb: () => void) { resized = cb; } observe() {} disconnect() { disconnected++; } } as unknown as typeof ResizeObserver;
  win.MutationObserver = class { constructor(cb: () => void) { moved = cb; } observe() {} disconnect() { disconnected++; } } as unknown as typeof MutationObserver;
  const menu = win.document.getElementById("menu")!;
  let positionedLeft = 223;
  menu.getBoundingClientRect = () => ({ left: positionedLeft + (parseFloat(menu.style.translate) || 0), width: 200 }) as DOMRect;
  const dispose = keepMenuInViewport(menu);
  assert.equal(menu.getBoundingClientRect().left, 112);
  resized!();
  assert.equal(menu.getBoundingClientRect().left, 112);
  positionedLeft = -105;
  moved!();
  assert.equal(menu.getBoundingClientRect().left, 8);
  assert.equal(menu.style.maxWidth, "304px");
  dispose();
  assert.equal(disconnected, 2);
  assert.equal(menu.style.translate, "");
  dom.window.close();
});
