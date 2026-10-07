import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React, { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { resolveEditorMode } from "../../features/editor/editor-entry";

/**
 * The simple editor's 画布 pill with unsaved edits.
 *
 * Switching wrote editorMode=advanced, the route decided on the canvas and
 * navigated — straight into the leave guard. Choosing "stay" left a spinner
 * with nothing to take it down (the dialog was not even rendered on the
 * spinner branch). Now the route waits for the switch's save, and if the
 * guard still holds the redirect and the creator stays, it shows the editor.
 */
test("the canvas redirect waits for the save and falls back to the editor when the guard holds it", async (suite) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/app/worlds/saved-card/edit" });
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const require = createRequire(import.meta.url);
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(fn => fn());
  const store = {
    worldDraft: { id: "saved", editorMode: "advanced" } as Record<string, unknown>,
    serverWorldId: "saved-card", isDirty: true, layoutDirty: false, saving: true, loadingWorld: false,
    guestMode: false, readOnlyInspect: false,
    stopAutosave: () => {}, releaseDiscardedWorld: () => {}, loadWorld: async () => {},
    setField: () => {},
  };
  const useEditorStore = Object.assign(
    (selector: (state: typeof store) => unknown) => useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => selector(store)),
    { getState: () => store },
  );
  const navigations: string[] = [];
  const router = { history: {}, navigate: (args: { to: string }) => { navigations.push(args.to); return new Promise(() => {}); } };
  let blocker = { status: "idle" };
  const blockerListeners = new Set<() => void>();
  const setBlocker = (status: string) => { blocker = { status }; blockerListeners.forEach(fn => fn()); };
  const mocks: Record<string, unknown> = {
    "@tanstack/react-router": { createFileRoute: () => (config: object) => ({ ...config, useParams: () => ({ worldId: "saved-card" }) }), useRouter: () => router },
    "lucide-react": new Proxy({}, { get: () => () => null }),
    "@/stores/editor": { useEditorStore },
    "@/lib/lazy-route-component": { lazyRouteComponent: (_loader: unknown, select: (module: unknown) => unknown) => select({
      EditorShell: () => <div>LEGACY</div>,
      QuickCreateEditor: () => <div>SIMPLE</div>,
    }) },
    "@/features/editor/lib/editor-mode": { getGlobalEditorMode: () => null, getEditorMode: () => null },
    "@/features/editor/use-unsaved-changes-guard": {
      useUnsavedChangesGuard: () => useSyncExternalStore(fn => { blockerListeners.add(fn); return () => { blockerListeners.delete(fn); }; }, () => blocker),
    },
    "@/features/editor/unsaved-changes-dialog": { UnsavedChangesDialog: ({ blocker: b }: { blocker: { status: string } }) => b.status === "blocked" ? <div>DIALOG</div> : null },
    "@/features/editor/editor-draft-recovery": { backupEditorDraft: () => false },
    "@/lib/safe-back": { navigateBackSafely: () => {} },
    "@/features/editor/editor-entry": { resolveEditorMode },
    "@/lib/blueprint-access": { fetchBlueprintAccess: async () => true },
    "@/lib/editor-surface": { getEditorSurface: () => null, isPhoneScreen: () => false, shouldOpenVisual: ({ mode }: { mode: string }) => mode === "advanced" },
    "@/lib/use-desktop-viewport": { useIsDesktopViewport: () => true },
  };
  const source = readFileSync(new URL("./worlds.$worldId.edit.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module = { exports: {} as { Route: { component: React.ComponentType } } };
  new Function("require", "module", "exports", compiled)((name: string) => mocks[name] ?? require(name), module, module.exports);
  const EditPage = module.exports.Route.component;

  document.body.innerHTML = "<div id='root'></div>";
  const root = createRoot(document.getElementById("root")!);
  const text = () => document.body.textContent ?? "";
  try {
    await act(async () => { root.render(<EditPage />); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

    await suite.test("no redirect while the switch's save is in flight", () => {
      assert.equal(navigations.length, 0);
      assert.ok(!text().includes("LEGACY"), "still the spinner, not a flash of the classic editor");
    });

    await act(async () => { store.saving = false; emit(); });
    await suite.test("once the save settles the redirect goes, exactly once", () => {
      assert.deepEqual(navigations, ["/app/studio/$worldId"]);
    });

    await act(async () => setBlocker("blocked"));
    await suite.test("the guard's question is on screen over the spinner", () => {
      assert.ok(text().includes("DIALOG"));
    });

    await act(async () => setBlocker("idle"));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    await suite.test("choosing to stay shows the editor instead of spinning forever", () => {
      assert.ok(text().includes("LEGACY"));
      assert.equal(navigations.length, 1, "it does not try again on its own");
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, { window: originalWindow, document: originalDocument, IS_REACT_ACT_ENVIRONMENT: false });
  }
});
