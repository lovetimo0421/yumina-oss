import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import { create } from "zustand";
import type { SessionPickerModalProps } from "./session-picker-modal";

for (const mode of ["single", "language", "versions"] as const) {
  test(`new-session ${mode} path waits for a successful persona selection, including before React rerenders`, async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: "https://test.local" });
    const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ data: [] });
    const store = create(() => ({ savingSelection: false, selectionFailed: false }));
    const variants = mode === "single" ? [] : [
      { id: "world", name: "First", language: "en" },
      { id: "other", name: "Second", language: mode === "language" ? "zh" : "en" },
    ];
    const t = (key: string) => key;
    const modules: Record<string, unknown> = {
      "react-i18next": { useTranslation: () => ({ t, i18n: { language: "en" } }) },
      "@/stores/personas": { usePersonasStore: store },
      "@/lib/auth-client": { useSession: () => ({ data: { user: { id: "user" } } }) },
      "@/lib/session-picker-cache": { getCachedSessions: () => [], setCachedSessions: () => {} },
      "@/lib/feedback": { feedback: {} }, "@/lib/playtime": {}, "@/lib/format-time": {},
      "@/lib/languages": { LANGUAGE_SHORT: {}, variantRowLabels: () => new Map() },
      "@/components/session-modal-styles": {},
      "@/features/chat/world-persona-menu": { WorldPersonaIconMenu: () => null },
      "@/components/version-picker-modal": { soleCurrentLanguageVariant: () => mode === "language" ? variants[0] : null },
    };
    const require = createRequire(import.meta.url);
    const module = { exports: {} as { SessionPickerModal: ComponentType<SessionPickerModalProps> } };
    const source = readFileSync(new URL("./session-picker-modal.tsx", import.meta.url), "utf8").replaceAll("import.meta.env.VITE_API_URL", '""');
    new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
      (id: string) => modules[id] ?? require(id), module, module.exports);
    const root = createRoot(dom.window.document.getElementById("root")!);
    const created: string[] = [];
    const button = () => Array.from(dom.window.document.querySelectorAll("button")).find((el) => /header\.(newSession|startThisVersion)/.test(el.textContent ?? ""))!;
    try {
      await act(async () => root.render(createElement(module.exports.SessionPickerModal, {
        open: true, onClose() {}, onSelectSession() {}, onCreateSession: (id) => created.push(id),
        world: { id: "world", name: "World", languageGroupId: "group" }, variants: variants as SessionPickerModalProps["variants"],
      })));
      // A sole same-language version starts on the first click; only multilingual variants open the picker.
      if (mode === "versions") await act(async () => button().click());
      await act(async () => {
        store.setState({ savingSelection: true });
        button().click(); // Handler sees live store before disabled renders.
      });
      assert.equal(created.length, 0);
      assert.equal(button().disabled, true);
      await act(async () => store.setState({ savingSelection: false, selectionFailed: true }));
      assert.equal(button().disabled, true);
      assert.match(dom.window.document.body.textContent ?? "", /creationBlocked/);
      await act(async () => button().click());
      assert.equal(created.length, 0);
      await act(async () => store.setState({ selectionFailed: false }));
      assert.equal(button().disabled, false);
      await act(async () => button().click());
      assert.deepEqual(created, ["world"]);
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = originalFetch;
      dom.window.close();
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    }
  });
}
