import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";

// The card-picture ask: Draw stays disabled for a moment after opening (a card
// can't harvest a double-click), and the option checkbox comes back with the yes.
// The delay is long enough that a loaded test machine still checks "disarmed" inside it.
const ARM_MS = 1500;
test("confirm dialogs can arm late and return an option checkbox", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, FocusEvent: dom.window.FocusEvent, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
    NodeFilter: dom.window.NodeFilter, HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement, DocumentFragment: dom.window.DocumentFragment,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  const { createRoot } = await import("react-dom/client");
  const { GlobalConfirmDialog, confirmChoice } = await import("./global-confirm-dialog");

  const root = createRoot(dom.window.document.getElementById("root")!);
  const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const draw = () => [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent === "Draw")!;
  try {
    await act(async () => root.render(<GlobalConfirmDialog />));
    let answer: Promise<{ confirmed: boolean; option: boolean }> | undefined;
    await act(async () => {
      answer = confirmChoice("Each picture costs 20 mushies.", { title: "Draw?", confirmLabel: "Draw", armDelayMs: ARM_MS, option: { label: "Don't ask again", defaultChecked: true } });
    });
    const box = dom.window.document.querySelector<HTMLElement>('[role="checkbox"]')!;
    assert.equal(box.getAttribute("aria-checked"), "true");
    assert.equal(draw().disabled, true, "disarmed right after opening");
    await act(async () => draw().click());
    await wait(ARM_MS + 100);
    assert.equal(draw().disabled, false, "armed after the delay");
    await act(async () => box.click());
    assert.equal(box.getAttribute("aria-checked"), "false");
    await act(async () => draw().click());
    assert.deepEqual(await answer, { confirmed: true, option: false });

    // A request replacing an open one: Draw disarms again and the player's
    // unticked option stays unticked.
    let first: Promise<{ confirmed: boolean; option: boolean }> | undefined;
    let second: Promise<{ confirmed: boolean; option: boolean }> | undefined;
    const ask = () => confirmChoice("Each picture costs 20 mushies.", { confirmLabel: "Draw", armDelayMs: ARM_MS, option: { label: "Don't ask again", defaultChecked: true } });
    await act(async () => { first = ask(); });
    await wait(ARM_MS + 100);
    const box2 = () => dom.window.document.querySelector<HTMLElement>('[role="checkbox"]')!;
    await act(async () => box2().click());
    assert.equal(draw().disabled, false);
    await act(async () => { second = ask(); });
    assert.deepEqual(await first, { confirmed: false, option: false });
    assert.equal(draw().disabled, true, "disarmed again for the new request");
    assert.equal(box2().getAttribute("aria-checked"), "false", "not re-ticked");
    await wait(ARM_MS + 100);
    await act(async () => draw().click());
    assert.deepEqual(await second, { confirmed: true, option: false });
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 50)); // Radix restores focus on a timer
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
