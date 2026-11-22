import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, useState } from "react";
import { JSDOM } from "jsdom";
import { FloatingEditor } from "./floating-editor";
import { stepBack } from "../../lib/studio-back";

test("canvas entry Back and Escape keep edits and leave the assistant independently usable", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  let committed = "";
  function Harness() {
    const [open, setOpen] = useState(false);
    return <div>
      <div data-canvas>
        <button data-open onClick={() => setOpen(true)}>Entry</button>
        {open && <FloatingEditor dialog label="Entry details" container={document.querySelector("[data-canvas]")} anchor={() => ({ row: null, host: null })} onClose={() => setOpen(false)}>
          <input data-entry defaultValue="" onBlur={event => { committed = event.currentTarget.value; }} />
        </FloatingEditor>}
      </div>
      <textarea data-assistant />
    </div>;
  }
  const popup = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const open = async () => { const trigger = document.querySelector<HTMLButtonElement>("[data-open]")!; trigger.focus(); await act(async () => trigger.click()); };
  const escape = async (target: Element) => { await act(async () => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))); };
  try {
    await act(async () => root.render(createElement(Harness)));
    await open();
    assert.ok(popup()?.closest("[data-canvas]"));
    assert.equal(popup()?.getAttribute("aria-label"), "Entry details");
    assert.equal(popup()?.getAttribute("aria-modal"), null, "AI must not be made inert by a modal focus trap");
    const field = document.querySelector<HTMLInputElement>("[data-entry]")!;
    field.focus(); field.value = "unsaved entry text";
    let handled = false;
    await act(async () => { handled = stepBack(); });
    assert.equal(handled, true);
    assert.equal(committed, "unsaved entry text");
    assert.equal(popup(), null);
    assert.equal(stepBack(), false, "a second Back can leave Studio once the entry is closed");
    assert.equal(document.activeElement, document.querySelector("[data-open]"));

    await open();
    const assistant = document.querySelector<HTMLTextAreaElement>("[data-assistant]")!;
    assistant.focus(); assistant.value = "help with this entry";
    await escape(assistant);
    assert.ok(popup(), "Escape in AI leaves the entry open");
    await act(async () => { assert.equal(stepBack(), true); });
    assert.equal(document.activeElement, assistant, "returning to the canvas does not steal AI focus");
    assert.equal(assistant.value, "help with this entry");

    await open();
    const lastField = document.querySelector<HTMLInputElement>("[data-entry]")!;
    lastField.focus(); lastField.value = "saved by escape";
    await escape(lastField);
    assert.equal(popup(), null);
    assert.equal(committed, "saved by escape");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
