import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

function installDom() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const original = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  return {
    dom,
    restore() {
      dom.window.close();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function button(name: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name,
  );
  assert.ok(found, `Missing button: ${name}`);
  return found;
}

async function openMenu() {
  const trigger = button("More actions");
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.click();
  });
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  assert.ok(menu, `More actions menu did not open: ${document.body.innerHTML}`);
  return menu;
}

test("story dock keeps extensions in a menu and fullscreen primary", async () => {
  const h = installDom();
  const { FullscreenFloatingControls } = await import(
    "../features/chat/fullscreen-floating-controls"
  );
  const root = createRoot(document.getElementById("root")!);
  const calls: string[] = [];
  const menuTransitions: boolean[] = [];
  try {
    await act(async () => {
      root.render(
        createElement(FullscreenFloatingControls, {
          backLabel: "Back to library",
          moreLabel: "More actions",
          modelLabel: "Model",
          memoryLabel: "Memory",
          stateGuardLabel: "State Update Guard",
          fullscreenLabel: "Return to fullscreen",
          showActions: true,
          onBack: () => calls.push("back"),
          onModel: () => calls.push("model"),
          onMemory: () => calls.push("memory"),
          onStateGuard: () => calls.push("guard"),
          onFullscreen: () => calls.push("fullscreen"),
          onInteractionStart: () => calls.push("interaction"),
          onMenuOpenChange: (open) => menuTransitions.push(open),
        }),
      );
    });

    const back = button("Back to library");
    const more = button("More actions");
    const fullscreen = button("Return to fullscreen");
    assert.equal(back.textContent?.trim(), "");
    assert.equal(more.textContent?.trim(), "");
    assert.match(back.className, /h-11 w-11/);
    assert.match(more.className, /h-11 w-11/);
    assert.match(fullscreen.className, /bg-primary/);
    assert.equal(fullscreen.closest('[role="menu"]'), null);
    assert.equal(document.body.textContent?.includes("Model"), false);

    for (const [label, expected] of [
      ["Model", "model"],
      ["Memory", "memory"],
      ["State Update Guard", "guard"],
    ] as const) {
      const menu = await openMenu();
      assert.equal(menuTransitions.at(-1), true);
      const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      assert.ok(item, `Missing menu item: ${label}`);
      assert.match(item.className, /min-h-11/);
      await act(async () => item.click());
      assert.equal(calls.at(-1), expected);
      assert.equal(menuTransitions.at(-1), false);
    }

    await act(async () => fullscreen.click());
    assert.equal(calls.at(-1), "fullscreen");

    await act(async () => {
      root.render(
        createElement(FullscreenFloatingControls, {
          backLabel: "Back to library",
          moreLabel: "More actions",
          modelLabel: "Model",
          fullscreenLabel: "Return to fullscreen",
          showActions: true,
          onBack: () => {},
          onModel: () => {},
          onMemory: () => {},
          onFullscreen: () => {},
          onInteractionStart: () => {},
          onMenuOpenChange: () => {},
        }),
      );
    });
    const minimalMenu = await openMenu();
    assert.deepEqual(
      [...minimalMenu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()),
      ["Model"],
    );
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.restore();
  }
});

test("auto-hide pauses for either pointer hover or an open portaled menu", async () => {
  const { shouldPauseFloatingBarAutoHide } = await import(
    "../features/chat/fullscreen-floating-controls"
  );
  assert.equal(shouldPauseFloatingBarAutoHide(false, false), false);
  assert.equal(shouldPauseFloatingBarAutoHide(true, false), true);
  assert.equal(shouldPauseFloatingBarAutoHide(false, true), true);
});
