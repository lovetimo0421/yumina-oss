import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import { create } from "zustand";

test("central persona selection is a native disabled button; navigation and edit do not select", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const personas = create(() => ({ personas: [{ id: "A", name: "Same", note: "First", isActive: true }, { id: "B", name: "Same", note: "Second", isActive: false }], loading: false, savingSelection: false, fetchPersonas: async () => {} }));
  const modules: Record<string, unknown> = {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/stores/personas": { usePersonasStore: personas },
    "@/lib/asset-url": { resolveImageUrl: () => null, cardImageUrl: () => null },
    "@/components/ui/field-error": { FieldError: () => null },
  };
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { PersonaCarousel: ComponentType<Record<string, unknown>> } };
  new Function("require", "module", "exports", transform(readFileSync(new URL("./persona-carousel.tsx", import.meta.url), "utf8"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)((id: string) => modules[id] ?? require(id), module, module.exports);
  const root = createRoot(dom.window.document.getElementById("root")!);
  const selected: (string | null)[] = [], edited: unknown[] = [];
  const render = (disabled: boolean) => root.render(createElement(module.exports.PersonaCarousel, { disabled, onEdit: (p: unknown) => edited.push(p), sessionSelection: { personaId: "A", hasPersona: true, onSelect: async (id: string | null) => { selected.push(id); } } }));
  const button = () => dom.window.document.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
  try {
    await act(async () => render(false));
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Next persona"]')!.click());
    assert.equal(selected.length, 0);
    assert.match(button().textContent ?? "", /Second/);
    assert.equal(button().querySelector("button"), null, "edit/delete are not nested inside selection");
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[aria-label="persona.edit"]')!.click());
    assert.equal(edited.length, 1); assert.equal(selected.length, 0);
    await act(async () => render(true));
    assert.equal(button().disabled, true);
    await act(async () => button().click());
    assert.equal(selected.length, 0, "disabled native controls reject actual clicks");
    await act(async () => render(false));
    await act(async () => button().click());
    assert.deepEqual(selected, ["B"]);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Next persona"]')!.click());
    await act(async () => button().click());
    assert.deepEqual(selected, ["B", null]);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
