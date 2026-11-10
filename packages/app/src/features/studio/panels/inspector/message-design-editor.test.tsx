import test, { after } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { UiDoc, UiElement } from "@yumina/engine";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: "http://localhost" });
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
  localStorage: dom.window.localStorage, location: dom.window.location, sessionStorage: dom.window.sessionStorage,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
// Loaded through Vite: the editor reaches the editor store, which reads
// `import.meta.env` at module scope.
const vite = await createServer({
  configFile: false, root: fileURLToPath(new URL("../../../../..", import.meta.url)), appType: "custom", logLevel: "silent",
  resolve: { alias: { "@": fileURLToPath(new URL("../../../..", import.meta.url)), "@yumina/engine": fileURLToPath(new URL("../../../../../../engine/src/index.ts", import.meta.url)) } },
  esbuild: { jsx: "automatic" }, server: { middlewareMode: true },
});
const { MessageDesignEditor, makePresetRule } = await vite.ssrLoadModule("/src/features/studio/panels/inspector/message-design-editor.tsx") as typeof import("./message-design-editor");
after(async () => {
  await vite.close();
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

// Keys render as themselves, which makes them easy to find.
const i18n = createInstance();
await i18n.use(initReactI18next).init({ lng: "zh", resources: { zh: { editor: {} } }, interpolation: { escapeValue: false } });

const startDoc = (): UiDoc => ({
  version: 1,
  entryPageId: "p1",
  pages: [{ id: "p1", name: "Main", height: 812, elements: [{ id: "m", type: "messages", x: 0, y: 0, w: 375, h: 600 }] }],
});

async function mount() {
  let latest = startDoc();
  function Host() {
    const [doc, setDoc] = useState(latest);
    const lead = doc.pages[0]!.elements[0] as Extract<UiElement, { type: "messages" }>;
    return createElement(MessageDesignEditor, { lead, doc, pageId: "p1", edit: (next: UiDoc) => { latest = next; setDoc(next); } });
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(Host))));
  const part = () => latest.pages[0]!.elements[0] as Extract<UiElement, { type: "messages" }>;
  return { host, part, unmount: () => act(async () => root.unmount()) };
}
const click = (el: Element | null | undefined) => act(async () => {
  assert.ok(el, "element to click");
  el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
});
const byText = (host: Element, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text || (b.getAttribute("role") === "radio" && !!b.textContent?.endsWith(text)));

test("a look preset writes a whole message style, and 平台默认 clears it", async () => {
  const m = await mount();
  await click(byText(m.host, "studio.messages.presets.novel"));
  assert.equal(m.part().messageStyle?.preset, "novel");
  assert.equal(m.part().messageStyle?.showNames, false);
  await click(byText(m.host, "studio.messages.presets.default"));
  assert.equal(m.part().messageStyle, undefined);
  await m.unmount();
});

test("rules are added from presets, reordered, switched off and removed", async () => {
  const m = await mount();
  // Special formats sit under the fine-tuning line, folded until opened.
  await click(byText(m.host, "studio.messages.fineTune"));
  await click(byText(m.host, "studio.messages.add"));
  await click(byText(m.host, "studio.messages.rulePresets.inner-thought"));
  await click(byText(m.host, "studio.messages.add"));
  await click(byText(m.host, "studio.messages.rulePresets.choice-buttons"));
  assert.deepEqual(m.part().rules?.map((r) => r.show), ["reveal", "choices"]);
  assert.deepEqual(m.part().rules?.[1]?.match, { kind: "line-prefix", prefix: "※" });

  // The newest rule is open: move it up, then switch it off.
  await click(m.host.querySelector('[aria-label="studio.messages.moveUp"]'));
  assert.deepEqual(m.part().rules?.map((r) => r.show), ["choices", "reveal"]);
  const switches = m.host.querySelectorAll('[role="switch"][aria-label="studio.messages.enable"]');
  await click(switches[0]);
  assert.equal(m.part().rules?.[0]?.enabled, false);

  await click(byText(m.host, "studio.messages.remove"));
  assert.equal(m.part().rules?.length, 1);
  await click([...m.host.querySelectorAll('[aria-label="studio.messages.expand"]')][0]);
  await click(byText(m.host, "studio.messages.remove"));
  assert.equal(m.part().rules, undefined, "no rules left: the field leaves the document");
  await m.unmount();
});

test("preset rules take the creator's words for their marker", () => {
  const t = (key: string) => ({ "studio.messages.cardMarker": "[BROADCAST]", "studio.messages.cardTitleDefault": "Broadcast" } as Record<string, string>)[key] ?? key;
  const rule = makePresetRule("special-card", t);
  assert.deepEqual(rule.match, { kind: "contains", text: "[BROADCAST]" });
  assert.equal(rule.options?.title, "Broadcast");
  assert.match(rule.id, /^rule-/);
});
