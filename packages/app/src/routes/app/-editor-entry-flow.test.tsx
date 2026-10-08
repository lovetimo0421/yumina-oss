import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React, { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { prepareStudioEntry, resolveEditorMode } from "../../features/editor/editor-entry";
import { backupEditorDraft } from "../../features/editor/editor-draft-recovery";

// Mount the actual route modules. Only their network/store dependencies and
// large editor children are replaced; clicks execute the production handlers.
test("creation, import, and reopening preserve content and choose the intended editor", async (suite) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/app/worlds/create" });
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalStorage = globalThis.localStorage;
  dom.window.scrollTo = () => {};
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  const require = createRequire(import.meta.url);
  let preference: "simple" | "advanced" | null = null;
  let authenticated = true;
  let allowSave = true;
  let creates = 0;
  let saves = 0;
  let imports = 0;
  let coverUploads = 0;
  let importedCover: Blob | undefined;
  const navigations: Array<{ to: string; params: { worldId: string } }> = [];
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(fn => fn());
  const store = {
    worldDraft: { id: "empty", name: "", entries: [] } as { id: string; [key: string]: unknown },
    serverWorldId: null as string | null, isDirty: false, layoutDirty: false, saving: false, loadingWorld: false,
    language: "zh", guestMode: false, readOnlyInspect: false, loadError: null,
    setGuestMode: (value: boolean) => { store.guestMode = value; },
    stopAutosave: () => {},
    releaseDiscardedWorld: () => {},
    clearHistory: () => {},
    createNew: () => { creates++; store.worldDraft = { id: "new", entries: [] }; store.serverWorldId = null; store.isDirty = false; emit(); },
    loadTemplate: () => { throw new Error("not a template test"); },
    loadWorldDefinition: (world: { id: string; [key: string]: unknown }) => { imports++; store.worldDraft = structuredClone(world); store.serverWorldId = null; store.isDirty = true; emit(); },
    loadWorld: async () => {},
    setField: (key: string, value: unknown) => { store.worldDraft = { ...store.worldDraft, [key]: value }; store.isDirty = true; emit(); },
    setLanguage: (language: string) => { store.language = language; },
    saveDraft: async () => {
      saves++; store.saving = true; emit(); await Promise.resolve(); store.saving = false;
      if (allowSave) { store.serverWorldId = "saved-card"; store.isDirty = false; }
      emit(); return allowSave;
    },
    applyImportedCover: async () => { coverUploads++; store.setField("avatar", "uploaded-cover"); },
  };
  const useEditorStore = Object.assign(
    (selector: (state: typeof store) => unknown) => useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => selector(store)),
    { getState: () => store },
  );
  const router = { history: {}, navigate: async (args: typeof navigations[number]) => {
    assert.equal(store.isDirty, false, "never navigate with unsaved content"); navigations.push(args);
  } };
  const translate = (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key;
  const setPickerActive = () => {};
  const mocks: Record<string, unknown> = {
    "@tanstack/react-router": { createFileRoute: () => (config: object) => ({ ...config, useParams: () => ({ worldId: "saved-card" }) }), useNavigate: () => router.navigate, useRouter: () => router },
    "lucide-react": new Proxy({}, { get: () => () => null }),
    "react-i18next": { useTranslation: () => ({ t: translate }) },
    "@/stores/editor": { useEditorStore },
    "@yumina/shared": { clampWorldTags: (value: unknown) => value },
    "@/hooks/use-auth-guard": { useAuthGuard: () => ({ isAuthenticated: authenticated, requireAuth: () => {} }) },
    "@/lib/world-templates": { WORLD_TEMPLATES: [], defaultOpening: () => ({ name: "Opening", content: "[first moment]" }) },
    "@/lib/import-world": { parseImportedFileFlexible: async () => ({ kind: "world", world: { id: "imported", name: "导入内容", entries: [{ id: "unique", content: "必须保留的正文" }], variables: [], rules: [], components: [] }, coverImage: importedCover }) },
    "@/lib/i18n-toast": { tToast: { success: () => {} } },
    sonner: { toast: { error: () => {} } },
    "@/stores/create-page": { useCreatePageStore: (selector: (state: unknown) => unknown) => selector({ setPickerActive }) },
    "@/lib/lazy-route-component": { lazyRouteComponent: (_loader: unknown, select: (module: unknown) => unknown) => select({
      EditorShell: () => <div>LEGACY</div>,
      StudioShell: () => <div>STUDIO</div>,
      QuickCreateEditor: ({ onOpenFullEditor }: { onOpenFullEditor: () => void }) => <button onClick={onOpenFullEditor}>SIMPLE_ADVANCE</button>,
    }) },
    "@/lib/i18n": { __esModule: true, default: { language: "zh", loadNamespaces: async () => {}, t: translate } },
    "@/features/editor/lib/editor-mode": { getGlobalEditorMode: () => preference, getEditorMode: () => null, saveGlobalEditorMode: (value: typeof preference) => { preference = value; } },
    "@/features/editor/use-unsaved-changes-guard": { useUnsavedChangesGuard: () => ({ status: "idle" }) },
    "@/features/editor/unsaved-changes-dialog": { UnsavedChangesDialog: () => null },
    "@/features/editor/editor-entry": { prepareStudioEntry, resolveEditorMode },
    "@/features/editor/editor-draft-recovery": { backupEditorDraft },
    "@/lib/auth-client": { getSessionSafe: async () => ({ data: {} }) },
    "@/lib/safe-back": { navigateBackSafely: () => {} },
    "@/features/editor/editor-unavailable": { EditorUnavailable: () => <div>UNAVAILABLE</div>, useEditorOwnership: () => null },
    // The re-import offer reads the real editor store (and analytics) — nothing here is one of the creator's own cards.
    "@/features/world-changes/apply-world-changes": { findImportTargets: async () => [] },
    "@/features/world-changes/apply-changes-dialog": { ApplyChangesDialog: () => null },
  };
  const loadRoute = (filename: string) => {
    const source = readFileSync(new URL(filename, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const module = { exports: {} as { Route: { component: React.ComponentType } } };
    new Function("require", "module", "exports", compiled)((name: string) => mocks[name] ?? require(name), module, module.exports);
    return module.exports.Route.component;
  };
  const CreatePage = loadRoute("./worlds.create.tsx");
  const EditPage = loadRoute("./worlds.$worldId.edit.tsx");
  const StudioPage = loadRoute("./studio.$worldId.tsx");
  const reset = () => {
    preference = null; authenticated = true; allowSave = true; creates = 0; saves = 0; imports = 0; coverUploads = 0; importedCover = undefined; navigations.length = 0;
    store.serverWorldId = null; store.isDirty = false; store.saving = false; store.worldDraft = { id: "empty", entries: [] };
    store.layoutDirty = false; store.guestMode = false; store.readOnlyInspect = false; localStorage.clear();
  };
  const withPage = async (Page: React.ComponentType, check: () => Promise<void>) => {
    document.body.innerHTML = "<div id='root'></div>";
    const root = createRoot(document.getElementById("root")!);
    try { await act(async () => { root.render(<Page />); }); await check(); }
    finally { await act(async () => root.unmount()); }
  };
  const click = async (text: string) => {
    const button = [...document.querySelectorAll("button")].find(node => node.textContent?.includes(text));
    assert.ok(button, `button exists: ${text}`);
    await act(async () => button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  };
  const upload = async () => {
    const input = document.querySelector("input[type=file]")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new dom.window.File(["test"], importedCover ? "card.png" : "card.json")] });
    await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  };
  try {
    for (const mode of ["simple", "advanced"] as const) await suite.test(`unpreferred JSON import keeps content when ${mode} is selected`, async () => {
      reset();
      await withPage(CreatePage, async () => {
        await upload();
        assert.equal(imports, 1);
        await click(mode === "simple" ? "quickCreate.modeSimpleTitle" : "quickCreate.modeAdvancedTitle");
        assert.equal(creates, 0, "mode selection must never reinitialize imported data");
        assert.deepEqual(store.worldDraft.entries, [{ id: "unique", content: "必须保留的正文" }]);
        if (mode === "advanced") {
          assert.equal(navigations.length, 0, "advanced opens here; the blueprint is somewhere you go from it");
          assert.ok(document.body.textContent?.includes("LEGACY"));
        } else assert.ok(document.body.textContent?.includes("SIMPLE_ADVANCE"));
      });
    });
    await suite.test("PNG without preference keeps its cover when advanced opens", async () => {
      reset(); importedCover = new Blob(["png"]);
      await withPage(CreatePage, async () => {
        await upload(); await click("quickCreate.modeAdvancedTitle");
        assert.equal(creates, 0); assert.equal(coverUploads, 1);
        assert.equal(store.worldDraft.avatar, "uploaded-cover");
        assert.equal(navigations.length, 0, "the card opens where it was made");
        assert.ok(document.body.textContent?.includes("LEGACY"));
      });
    });
    await suite.test("an import whose save fails still opens with its content, not an error screen", async () => {
      // Advanced used to save the draft before it could open, so a failed save
      // met the author with a retry card instead of the card they imported.
      // Opening no longer waits on the network; the autosave catches up.
      reset(); preference = "advanced"; allowSave = false;
      await withPage(CreatePage, async () => {
        await upload();
        assert.equal(imports, 1); assert.equal(creates, 0);
        assert.deepEqual(store.worldDraft.entries, [{ id: "unique", content: "必须保留的正文" }]);
        assert.ok(document.body.textContent?.includes("LEGACY"));
      });
    });
    await suite.test("a reopened advanced card opens the editor, and Simple switches to it in place", async () => {
      reset(); store.serverWorldId = "saved-card"; store.worldDraft = { id: "saved", editorMode: "advanced" };
      await withPage(EditPage, async () => {
        assert.equal(navigations.length, 0, "advanced is this editor, not a redirect to the blueprint");
        assert.equal(saves, 0);
        assert.ok(document.body.textContent?.includes("LEGACY"));
      });
      reset(); store.serverWorldId = "saved-card"; store.worldDraft = { id: "saved", editorMode: "simple", entries: ["保持正文"] };
      await withPage(EditPage, async () => {
        assert.equal(navigations.length, 0); await click("SIMPLE_ADVANCE");
        assert.equal(navigations.length, 0, "switching mode swaps the shell without a route change");
        assert.ok(document.body.textContent?.includes("LEGACY"));
        assert.deepEqual(store.worldDraft.entries, ["保持正文"]);
      });
    });
    await suite.test("guest advanced remains a local preview without a remote save", async () => {
      reset(); authenticated = false; preference = "advanced";
      await withPage(CreatePage, async () => { await click("templates.blank"); assert.equal(saves, 0); assert.ok(document.body.textContent?.includes("LEGACY")); });
    });
    await suite.test("a new advanced world opens in the editor and leaves the blueprint's own layout alone", async () => {
      reset(); preference = "advanced";
      localStorage.setItem("yumina-studio-stage-v2", "classic");
      localStorage.setItem("yumina-stage-ai", "closed");
      localStorage.setItem("yumina-stage-tree-v2", "open");
      await withPage(CreatePage, async () => {
        await click("templates.blank");
        assert.equal(creates, 1);
        assert.equal(navigations.length, 0);
        assert.ok(document.body.textContent?.includes("LEGACY"));
        // Making a card used to reset the canvas's panels on the way in. It no
        // longer opens the canvas, so it has no business touching them.
        assert.equal(localStorage.getItem("yumina-studio-stage-v2"), "classic");
        assert.equal(localStorage.getItem("yumina-stage-ai"), "closed");
        assert.equal(localStorage.getItem("yumina-stage-tree-v2"), "open");
      });
    });
    await suite.test("Studio captures immediate edits on page hide, while successful saves leave no recovery backup", async () => {
      reset(); store.serverWorldId = "saved-card"; store.worldDraft = { id: "saved", entries: ["刚编辑的内容"] };
      await withPage(StudioPage, async () => {
        assert.ok(document.body.textContent?.includes("STUDIO"));
        // No React rerender/periodic autosave is needed for this last-moment edit.
        store.isDirty = true;
        window.dispatchEvent(new dom.window.Event("pagehide"));
        const backup = JSON.parse(localStorage.getItem("yumina-editor-draft")!);
        assert.deepEqual(backup.draft.entries, ["刚编辑的内容"]);
        localStorage.clear(); store.isDirty = false;
        window.dispatchEvent(new dom.window.Event("beforeunload"));
        assert.equal(localStorage.getItem("yumina-editor-draft"), null);
      });
    });
  } finally {
    dom.window.close();
    Object.assign(globalThis, { window: originalWindow, document: originalDocument, localStorage: originalStorage, IS_REACT_ACT_ENVIRONMENT: false });
  }
});
