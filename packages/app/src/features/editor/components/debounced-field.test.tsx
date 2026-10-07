import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement, useState } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

/**
 * The shared debounced field, on its own.
 *
 * These cases used to be tested through the blueprint's canvas editor, which
 * was the loudest user of the field until the writing moved into the column
 * beside the board. The field itself did not change, and neither did what it
 * has to get right: one commit per pause, never a half-typed Chinese word, a
 * flush before the save shortcut, and an authoritative snapshot that can
 * supersede whatever is in a focused box.
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
const { DebouncedTextarea } = await vite.ssrLoadModule("/src/features/editor/components/debounced-field.tsx") as typeof import("./debounced-field");
after(async () => {
  await vite.close();
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

type Props = { value: string; syncKey?: string; forceSyncKey?: number; readOnly?: boolean; flushOnSave?: boolean };

async function withField(initial: Props, run: (context: {
  field: HTMLTextAreaElement;
  commits: string[];
  saves: string[];
  container: HTMLElement;
  input: (value: string) => Promise<void>;
  compose: (type: "compositionstart" | "compositionend") => Promise<void>;
  blur: () => Promise<void>;
  keyDown: (key: string, modifiers?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => Promise<void>;
  pause: (ms?: number) => Promise<void>;
  update: (next: Partial<Props>) => Promise<void>;
}) => Promise<void>) {
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const commits: string[] = [];
  const saves: string[] = [];
  let props: Props = { flushOnSave: true, ...initial };
  let apply: (next: Partial<Props>) => void = () => {};
  function Harness() {
    const [live, setLive] = useState(props);
    apply = next => { props = { ...props, ...next }; setLive(props); };
    // The shell owns Ctrl+S; the field only has to have flushed by the time it
    // gets there, so the listener sits outside it exactly as the shell does.
    return createElement("div", { onKeyDown: (event: { key: string; ctrlKey: boolean; metaKey: boolean }) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") saves.push(commits.at(-1) ?? "");
    } }, createElement(DebouncedTextarea, {
      value: live.value, syncKey: live.syncKey, forceSyncKey: live.forceSyncKey,
      readOnly: live.readOnly, flushOnSave: live.flushOnSave,
      onCommit: (next: string) => { commits.push(next); },
    }));
  }
  await act(async () => root.render(createElement(Harness)));
  const field = () => container.querySelector("textarea")!;
  try {
    await run({
      field: field(), commits, saves, container,
      input: async value => { await act(async () => {
        const target = field();
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(target, value);
        target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      }); },
      compose: async type => { await act(async () => field().dispatchEvent(new dom.window.CompositionEvent(type, { bubbles: true }))); },
      blur: async () => { await act(async () => field().dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }))); },
      keyDown: async (key, modifiers = {}) => { await act(async () => field().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, ...modifiers }))); },
      pause: async (ms = 350) => { await act(async () => new Promise(resolve => setTimeout(resolve, ms))); },
      update: async next => { await act(async () => apply(next)); },
    });
  } finally { await act(async () => root.unmount()); }
}

test("continuous typing commits once per pause, IME never commits a partial composition, and blur flushes", async () => {
  await withField({ value: "", syncKey: "lore" }, async ({ field, commits, input, compose, pause, blur }) => {
    field.focus();
    for (const text of ["T", "Th", "The", "The story"]) await input(text);
    assert.equal(field.value, "The story", "the local field updates without waiting for the store");
    assert.equal(commits.length, 0);
    await pause();
    assert.deepEqual(commits, ["The story"]);
    await compose("compositionstart");
    await input("hui");
    await pause();
    assert.equal(commits.length, 1, "intermediate IME text cannot reach the store or enter undo history");
    await input("灰岸");
    await compose("compositionend");
    assert.equal(commits.at(-1), "灰岸");
    await input("灰岸的清晨");
    await blur();
    assert.equal(commits.length, 3);
    assert.equal(commits.at(-1), "灰岸的清晨");
    await pause();
    assert.equal(commits.length, 3, "blur clears the timer instead of producing a second commit");
  });
});

test("an authoritative revision supersedes a focused field, and its pending edit is cancelled with it", async () => {
  await withField({ value: "第一段开场", syncKey: "created", forceSyncKey: 1 }, async ({ field, commits, input, update, pause }) => {
    field.focus();
    await input("A queued edit before undo");
    assert.equal(commits.length, 0);
    await update({ value: "", forceSyncKey: 2 });
    assert.equal(dom.window.document.activeElement, field, "undo does not lose keyboard focus");
    assert.equal(field.value, "", "the authoritative snapshot supersedes the old focused value");
    await pause();
    assert.equal(commits.length, 0, "the cancelled queued edit cannot resurrect the undone text");
    await update({ value: "第一段开场", forceSyncKey: 3 });
    assert.equal(field.value, "第一段开场", "redo uses the snapshot paired with its revision as well");
    assert.equal(commits.length, 0);
  });
});

test("an unfocused field follows the bound value; a focused one is never yanked out from under the typist", async () => {
  await withField({ value: "Card A", syncKey: "a" }, async ({ field, commits, input, update, pause, blur }) => {
    // Nobody is typing: the field is a view of the value it was given.
    await update({ value: "From the agent", syncKey: "a" });
    assert.equal(field.value, "From the agent");
    // Now somebody is. A value arriving from elsewhere waits its turn — the
    // whole reason this field exists is that it must not eat a keystroke.
    field.focus();
    await input("Mine, still being written");
    await update({ value: "From the agent again", syncKey: "a" });
    assert.equal(field.value, "Mine, still being written");
    await blur();
    assert.deepEqual(commits, ["Mine, still being written"], "leaving the field commits what was in it");
    await pause();
    assert.equal(commits.length, 1);
  });
});
