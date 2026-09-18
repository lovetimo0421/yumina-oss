import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import { create } from "zustand";

test("session picker uses the committed global choice, disables pending choices, and reports failed saves", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const calls: (string | null)[] = [];
  let finish!: (saved: boolean) => void;
  const select = (id: string | null) => {
    calls.push(id);
    store.setState({ savingSelection: true });
    return new Promise<boolean>((resolve) => {
      finish = (saved) => {
        store.setState({ savingSelection: false, ...(saved ? { personas: store.getState().personas.map((p) => ({ ...p, isActive: p.id === id })) } : {}) });
        resolve(saved);
      };
    });
  };
  const store = create(() => ({ personas: [{ id: "A", name: "小月", isActive: true }, { id: "B", name: "月月", isActive: false }],
    savingSelection: false, fetchPersonas: async () => {}, activatePersona: (id: string) => select(id), deactivatePersonas: () => select(null) }));
  const t = (key: string, values?: { name: string }) => values?.name ?? key;
  const shell = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  const modules: Record<string, unknown> = {
    "react-i18next": { useTranslation: () => ({ t }) },
    "lucide-react": { Check: () => null, UserRound: () => null },
    "@/lib/auth-client": { useSession: () => ({ data: { user: { id: "user" } } }) },
    "@/stores/personas": { usePersonasStore: store },
    "@/components/ui/field-error": { FieldError: ({ message }: { message: string | null }) => createElement("p", { role: "alert" }, message) },
    "@/components/ui/dropdown-menu": { DropdownMenu: ({ open, children }: { open: boolean; children: ReactNode }) => createElement("div", { "data-open": open }, children),
      DropdownMenuTrigger: shell, DropdownMenuContent: shell,
      DropdownMenuItem: ({ children, onSelect, disabled, ...rest }: { children: ReactNode; onSelect: (event: { preventDefault(): void }) => void; disabled: boolean }) =>
        createElement("button", { ...rest, disabled, onClick: onSelect }, children) },
  };
  const module = { exports: {} as { WorldPersonaIconMenu: ComponentType<{ worldId: string }> } };
  new Function("require", "module", "exports", transform(readFileSync(new URL("./world-persona-menu.tsx", import.meta.url), "utf8"),
    { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
    (id: string) => modules[id] ?? createRequire(import.meta.url)(id), module, module.exports,
  );
  const root = createRoot(dom.window.document.getElementById("root")!);
  const items = () => [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  const click = (index: number) => items()[index]!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  try {
    await act(async () => root.render(createElement(module.exports.WorldPersonaIconMenu, { worldId: "world-with-legacy-pin" })));
    assert.equal(items()[1]!.getAttribute("aria-checked"), "true");
    await act(async () => { click(2); });
    assert.deepEqual(calls, ["B"]);
    assert.ok(items().every((item) => item.disabled));
    assert.equal(items()[1]!.getAttribute("aria-checked"), "true", "pending choice does not move the checkmark");
    await act(async () => finish(false));
    assert.equal(items()[1]!.getAttribute("aria-checked"), "true");
    assert.equal(dom.window.document.querySelector('[role="alert"]')?.textContent, "persona.session.saveError");
    await act(async () => { click(2); });
    await act(async () => finish(true));
    assert.equal(items()[2]!.getAttribute("aria-checked"), "true");
    assert.equal(dom.window.document.querySelector('[role="alert"]')?.textContent, "");
    await act(async () => { click(0); });
    await act(async () => finish(true));
    assert.equal(items()[0]!.getAttribute("aria-checked"), "true");
    assert.deepEqual(calls, ["B", "B", null]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
