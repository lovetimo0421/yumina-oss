import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement, useState } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

/**
 * Text still waiting on the debounce timer has to end up somewhere — and in
 * the right place.
 *
 *  - Unmounting (closing the panel, switching tabs) used to clear the timer
 *    and drop the last pause of typing.
 *  - Switching the field to another item while it kept focus left the old
 *    text on screen, and the next blur committed it over the NEW item.
 *  - A save asks every field to commit first (flushPendingEditorFields).
 */
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: "http://localhost" });
const globals = { window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const vite = await createServer({
  configFile: false, root: fileURLToPath(new URL("../../../..", import.meta.url)), appType: "custom", logLevel: "silent",
  resolve: { alias: { "@": fileURLToPath(new URL("../../..", import.meta.url)), "@yumina/engine": fileURLToPath(new URL("../../../../../engine/src/index.ts", import.meta.url)) } },
  esbuild: { jsx: "automatic" }, server: { middlewareMode: true },
});
const { DebouncedTextarea, flushPendingEditorFields } = await vite.ssrLoadModule("/src/features/editor/components/debounced-field.tsx") as typeof import("./debounced-field");
after(async () => {
  await vite.close();
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

type Item = { id: string; text: string };

async function mountItems(items: Record<string, string>) {
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const store = { ...items };
  const commits: Array<[string, string]> = [];
  let select: (id: string | null) => void = () => {};
  function Harness() {
    const [selected, setSelected] = useState<string | null>(Object.keys(items)[0]!);
    select = setSelected;
    if (selected === null) return null;
    const item: Item = { id: selected, text: store[selected]! };
    return createElement(DebouncedTextarea, {
      value: item.text, syncKey: item.id,
      onCommit: (next: string) => { store[item.id] = next; commits.push([item.id, next]); },
    });
  }
  await act(async () => root.render(createElement(Harness)));
  const field = () => container.querySelector("textarea");
  return {
    store, commits, field,
    input: async (value: string) => { await act(async () => {
      const target = field()!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(target, value);
      target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    }); },
    blur: async () => { await act(async () => field()!.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }))); },
    select: async (id: string | null) => { await act(async () => select(id)); },
    pause: async (ms = 350) => { await act(async () => new Promise(resolve => setTimeout(resolve, ms))); },
    unmount: async () => { await act(async () => root.unmount()); },
  };
}

test("unmounting mid-pause commits what was typed instead of dropping it", async () => {
  const h = await mountItems({ a: "" });
  h.field()!.focus();
  await h.input("The last words typed");
  assert.equal(h.commits.length, 0);
  await h.select(null);
  assert.deepEqual(h.commits, [["a", "The last words typed"]]);
  await h.pause();
  assert.equal(h.commits.length, 1, "the cancelled timer does not commit a second time");
  await h.unmount();
});

test("switching items while focused sends pending text to the old item and never writes it over the new one", async () => {
  const h = await mountItems({ a: "alpha", b: "bravo" });
  h.field()!.focus();
  await h.input("alpha, edited");
  await h.select("b");
  assert.equal(h.store.a, "alpha, edited", "the old item receives its own text");
  assert.equal(h.field()!.value, "bravo", "the box shows the new item even though it kept focus");
  await h.blur();
  await h.pause();
  assert.equal(h.store.b, "bravo", "blurring does not commit the old item's text into the new one");
  assert.deepEqual(h.commits, [["a", "alpha, edited"]]);
  await h.unmount();
});

test("a save's flush commits pending text immediately, once", async () => {
  const h = await mountItems({ a: "" });
  h.field()!.focus();
  await h.input("Ctrl+S right after typing");
  await act(async () => flushPendingEditorFields());
  assert.deepEqual(h.commits, [["a", "Ctrl+S right after typing"]]);
  assert.equal(dom.window.document.activeElement, h.field(), "the caret stays where it was");
  await h.pause();
  assert.equal(h.commits.length, 1);
  await h.unmount();
});
