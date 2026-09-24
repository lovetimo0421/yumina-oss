import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { act, createElement, type ComponentType } from "react";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";

test("compact pagination jumps to any valid page, rejects invalid values, and disables boundaries/loading", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { AssetPagination: ComponentType<{ page: number; totalPages: number; loading: boolean; onPageChange: (page: number) => void }> } };
  new Function("require", "module", "exports", transform(readFileSync(new URL("./asset-pagination.tsx", import.meta.url), "utf8"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
    (id: string) => id === "react-i18next" ? { useTranslation: () => ({ t: (key: string) => key }) } : require(id), module, module.exports,
  );
  const root = createRoot(dom.window.document.getElementById("root")!);
  const changes: number[] = [];
  const render = (page: number, loading = false, totalPages = 101) => root.render(createElement(module.exports.AssetPagination, { page, loading, totalPages, onPageChange: (next) => changes.push(next) }));
  const button = (label: string) => dom.window.document.querySelector<HTMLButtonElement>(`button[aria-label="assets.${label}"]`)!;
  async function submit(value: string) {
    await act(async () => {
      const input = dom.window.document.querySelector("input")!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => { dom.window.document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  }
  try {
    await act(async () => render(1));
    assert.equal(button("firstPage").disabled, true);
    assert.equal(button("prev").disabled, true);
    await submit("75");
    assert.deepEqual(changes, [75]);
    for (const value of ["", "0", "-1", "102", "1.5"]) await submit(value);
    assert.deepEqual(changes, [75]);
    await act(async () => button("lastPage").click());
    assert.deepEqual(changes, [75, 101]);
    await act(async () => render(101));
    assert.equal(dom.window.document.querySelector("input")!.value, "101");
    assert.equal(button("next").disabled, true);
    assert.equal(button("lastPage").disabled, true);
    await act(async () => render(101, true));
    assert([...dom.window.document.querySelectorAll("button")].every((element) => element.disabled));
    await submit("30");
    assert.deepEqual(changes, [75, 101]);
    await act(async () => render(1, false, 2));
    assert.equal(dom.window.document.querySelector("input")!.value, "1");
    assert.equal(dom.window.document.querySelector("input")!.max, "2");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
