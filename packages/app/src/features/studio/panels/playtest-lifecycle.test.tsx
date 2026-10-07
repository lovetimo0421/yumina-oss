import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React, { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { prepareStudioEntry } from "../../editor/editor-entry";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("the real playtest panel protects saves and session transitions", async (suite) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/app/studio/world" });
  const originals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(fn => fn());
  let saves = 0;
  let posts = 0;
  let stops = 0;
  let keepDirty = false;
  let loadGate: ReturnType<typeof deferred> | null = null;
  let createGate: ReturnType<typeof deferred> | null = null;
  const deletes: string[] = [];
  const loads: Array<{ id: string; shouldApply?: () => boolean }> = [];
  let onRun: ((id: string) => Promise<void>) | undefined;
  const editor = {
    worldDraft: { id: "schema", name: "Card" }, serverWorldId: "world", isDirty: false, saving: false,
    saveDraft: async () => { saves++; editor.isDirty = keepDirty; emit(); return true; },
  };
  const chat = {
    session: null as { id: string } | null, isStreaming: false,
    loadSession: async (id: string, shouldApply?: () => boolean) => {
      loads.push({ id, shouldApply });
      if (loadGate) await loadGate.promise;
      if (shouldApply && !shouldApply()) return;
      chat.session = { id }; emit();
    },
    startRuntimeRecording: () => {}, stopRuntimeRecording: () => {},
    stopGeneration: () => { stops++; chat.isStreaming = false; emit(); },
    setSession: (value: { id: string } | null) => { chat.session = value; emit(); },
    setMessages: () => {}, setGameState: () => {},
  };
  const store = <S extends object>(state: S) => Object.assign(
    (selector: (value: S) => unknown) => useSyncExternalStore(
      fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => selector(state)),
    { getState: () => state },
  );
  const useEditorStore = store(editor);
  const useChatStore = store(chat);
  // Whether the assistant is the one playing (null: the creator's own playtest).
  const studio = { aiPlaytest: null as null | { runId: string; sessionId: string; purpose: string; turn: number; total: number; done?: boolean } };
  const useStudioStore = Object.assign(store(studio), {
    setState: (patch: Partial<typeof studio>) => { Object.assign(studio, patch); emit(); },
  });
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "DELETE") { deletes.push(String(_url)); return new Response("{}", { status: 200 }); }
    assert.equal(init?.method, "POST");
    const id = `run-${++posts}`;
    if (createGate) await createGate.promise;
    return new Response(JSON.stringify({ data: { id } }), { status: 201 });
  }) as typeof fetch;
  const mocks: Record<string, unknown> = {
    "@/stores/editor": { useEditorStore, generatedInterfaceUnsaved: () => false }, "@/stores/chat": { useChatStore }, "@/stores/studio": { useStudioStore },
    "@/features/editor/editor-entry": { prepareStudioEntry },
    "../../editor/editor-entry": { prepareStudioEntry },
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "lucide-react": new Proxy({}, { get: () => () => null }),
    "@/lib/utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") },
    "@/features/chat/chat-view": { ChatView: () => <div>REAL_SESSION_VIEW</div> },
    "./playtest-runtime-log": { PlaytestRuntimeLog: () => null },
    "./playtest-recovery": { PlaytestRecovery: () => null },
    "./playtest-starts": { PlaytestStarts: (props: { onRun: (id: string) => Promise<void>; trailing?: React.ReactNode }) => { onRun = props.onRun; return <>{props.trailing}</>; } },
  };
  const source = readFileSync(new URL("./playtest-panel.tsx", import.meta.url), "utf8").replace("import.meta.env.VITE_API_URL", '""');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module = { exports: {} as { PlaytestPanel: React.ComponentType } };
  const require = createRequire(import.meta.url);
  new Function("require", "exports", compiled)((name: string) => mocks[name] ?? require(name), module.exports);
  const Panel = module.exports.PlaytestPanel;
  let root: Root | null = null;
  const reset = () => {
    editor.serverWorldId = "world";
    editor.isDirty = false; editor.saving = false; chat.session = null; chat.isStreaming = false;
    saves = 0; posts = 0; stops = 0; keepDirty = false; loadGate = null; createGate = null;
    deletes.length = 0; loads.length = 0; onRun = undefined; studio.aiPlaytest = null;
  };
  const mount = async () => {
    document.body.innerHTML = "<div id='root'></div>";
    root = createRoot(document.getElementById("root")!);
    await act(async () => root!.render(<Panel />));
  };
  const unmount = async () => { if (root) { await act(async () => root!.unmount()); root = null; } };
  try {
    await suite.test("switching cards replaces the old playtest and invalidates its pending load", async () => {
      reset(); loadGate = deferred();
      try {
        await mount(); assert.equal(loads.length, 1);
        await act(async () => { editor.serverWorldId = "other-world"; emit(); });
        assert.equal(posts, 2, "the new card creates its own session");
        assert.equal(loads[0]!.shouldApply!(), false, "old card's load cannot update the new card");
        await act(async () => { loadGate!.resolve(); await loadGate!.promise; });
        assert.equal(chat.session?.id, "run-2");
        assert.ok(deletes.some(url => url.endsWith("/run-1")));
      } finally { loadGate!.resolve(); await unmount(); }
    });
    await suite.test("an existing save is not duplicated and cannot start a stale playtest", async () => {
      reset(); editor.isDirty = true; editor.saving = true;
      try { await mount(); assert.equal(saves, 0); assert.equal(posts, 0); }
      finally { await unmount(); }
    });
    await suite.test("edits made during save keep the panel in error instead of running older saved content", async () => {
      reset(); editor.isDirty = true; keepDirty = true;
      try {
        await mount(); assert.equal(saves, 1); assert.equal(posts, 0);
        assert.ok(!document.body.textContent?.includes("REAL_SESSION_VIEW"));
      } finally { await unmount(); }
    });
    await suite.test("a running generation cannot be replaced through either reset entry", async () => {
      reset();
      try {
        await mount(); assert.equal(posts, 1);
        await act(async () => { chat.isStreaming = true; emit(); });
        const restart = document.querySelector<HTMLButtonElement>('button[title="studio.playtest.restart"]')!;
        assert.equal(restart.disabled, true);
        await act(async () => { await onRun!(""); });
        assert.equal(posts, 1, "programmatic reset also checks generation state");
        assert.equal(chat.session?.id, "run-1");
      } finally { await unmount(); }
    });
    await suite.test("closing during session load invalidates that load and cleans up the newly created session", async () => {
      reset(); loadGate = deferred();
      try {
        await mount(); assert.equal(loads.length, 1);
        assert.equal(typeof loads[0]!.shouldApply, "function");
        await unmount(); assert.equal(loads[0]!.shouldApply!(), false);
        await act(async () => { loadGate!.resolve(); await loadGate!.promise; });
        assert.equal(chat.session, null);
        assert.ok(deletes.some(url => url.endsWith("/run-1")));
      } finally { loadGate!.resolve(); await unmount(); }
    });
    await suite.test("while the assistant plays, the panel shows its session and never deletes it mid-play", async () => {
      reset();
      studio.aiPlaytest = { runId: "r", sessionId: "ai-1", purpose: "检查开场", turn: 0, total: 3 };
      try {
        await mount();
        assert.equal(posts, 0, "no session of the panel's own is made");
        assert.ok(loads.some(load => load.id === "ai-1"), "the assistant's session is shown");
        const before = loads.length;
        await act(async () => { studio.aiPlaytest = { ...studio.aiPlaytest!, turn: 1 }; emit(); });
        assert.ok(loads.length > before, "each turn reloads it so the new reply appears");
        await unmount();
        assert.ok(!deletes.some(url => url.endsWith("/ai-1")), "closing the panel does not pull it out from under the assistant");
      } finally { await unmount(); }
    });
    await suite.test("a creation response arriving after close is deleted without ever loading it", async () => {
      reset(); createGate = deferred();
      try {
        await mount(); assert.equal(posts, 1); await unmount();
        await act(async () => { createGate!.resolve(); await createGate!.promise; });
        assert.equal(loads.length, 0); assert.equal(chat.session, null);
        assert.ok(deletes.some(url => url.endsWith("/run-1")));
      } finally { createGate!.resolve(); await unmount(); }
    });
  } finally {
    await unmount(); dom.window.close();
    Object.assign(globalThis, { ...originals, IS_REACT_ACT_ENVIRONMENT: false });
  }
});
