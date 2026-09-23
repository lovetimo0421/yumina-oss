import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { NumberInput } from "./number-input";

test("number inputs render as one uninterrupted field without stepper tabs", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }

  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(<NumberInput value={16_000} min={2_048} max={64_000} step={1_024} onChange={() => {}} />);
    });

    assert.equal(element.querySelectorAll("button").length, 0);
    const input = element.querySelector<HTMLInputElement>('input[type="number"]')!;
    assert.equal(input.value, "16000");
    assert.equal(input.min, "2048");
    assert.equal(input.max, "64000");
    assert.equal(input.step, "1024");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
