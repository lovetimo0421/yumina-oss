import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React, { act, useEffect, useSyncExternalStore } from "react";
import { JSDOM } from "jsdom";
import ts from "typescript";

test("the real stage keeps one mounted canvas and assistant across docked tools, overlays and frontend visits", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/app/studio/card" });
  let workspaceWidth = 780;
  const observers = new Set<() => void>();
  // Dockview reads the entries it is handed; the stage only re-measures.
  class ResizeObserverStub {
    private notify = () => {};
    constructor(private callback: (entries: unknown[]) => void) {}
    observe(target: Element) {
      this.notify = () => this.callback([{ target, contentRect: { width: workspaceWidth, height: 800 } }]);
      observers.add(this.notify);
    }
    unobserve() {}
    disconnect() { observers.delete(this.notify); }
  }
  const globals = { window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, ResizeObserver: ResizeObserverStub, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number, cancelAnimationFrame: (id: number) => clearTimeout(id),
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: workspaceWidth, height: 800, x: 0, y: 0, left: 0, top: 0, right: workspaceWidth, bottom: 800, toJSON: () => ({}) });

  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  const learning = { step: null as string | null, setInspecting: (_inspecting: boolean) => {} };
  const editor = { serverWorldId: "card", worldDraft: { id: "card" }, variants: [], readOnlyInspect: false, guestMode: false, activeSection: "entries", pendingFocus: null, setActiveSection: (section:string) => { editor.activeSection = section; emit(); } };
  const studio = { mode: "edit", setMode: (mode:string) => { studio.mode = mode; emit(); }, stagePage: "blueprint", setStagePage: (page:string) => { studio.stagePage = page; emit(); },
    stageAssistant: null as { open: boolean; toggle: () => void } | null, setStageAssistant: (value: { open: boolean; toggle: () => void } | null) => { studio.stageAssistant = value; } };
  function store<S extends object>(state: S) {
    return Object.assign((selector: (value: S) => unknown) => useSyncExternalStore(
      listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => selector(state)),
    { getState: () => state, subscribe: () => () => {} });
  }
  let canvasMounts = 0, aiMounts = 0, playtestMounts = 0;
  let canvasProps!: { onDrillPanel: (id: string, how?: { focus?: boolean }) => void; active: boolean };
  function Canvas(props: typeof canvasProps) {
    canvasProps = props;
    useEffect(() => { canvasMounts++; }, []);
    useEffect(() => {
      const learn = (event: Event) => {
        const target = (event as CustomEvent<{canvasTarget:string}>).detail.canvasTarget;
        if (target === "memory") props.onDrillPanel("modules"); // no module yet
      };
      window.addEventListener("yumina:studio-learn-canvas", learn);
      return () => window.removeEventListener("yumina:studio-learn-canvas", learn);
    }, [props.onDrillPanel]);
    return <div data-canvas-sentinel />;
  }
  function Ai() { useEffect(() => { aiMounts++; }, []); return <textarea data-ai-composer />; }
  function Playtest() { useEffect(() => { playtestMounts++; }, []); return <div data-playtest />; }
  const pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const mocks: Record<string, unknown> = {
    "./learn/learning-workspace": { useLearningWorkspace: () => {
      useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => learning.step);
      return learning;
    } },
    "@/stores/editor": { useEditorStore: store(editor) }, "@/stores/studio": { useStudioStore: store(studio) },
    "@/hooks/use-auth-guard": { useAuthGuard: () => ({ isAuthenticated: true, requireAuth: () => true }) },
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "lucide-react": new Proxy({}, { get: () => () => null }),
    "@/lib/utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") },
    "@/features/editor/sections/components": { ComponentsSection: () => null },
    "@/features/editor/variant-tab-bar": { VariantTabBar: () => null },
    // Menu items become plain buttons so the test can pick one by its label;
    // the player view is reached through the editors menu now, not a page tab.
    "@/components/ui/dropdown-menu": new Proxy({}, { get: (_target, name) => name === "DropdownMenuItem"
      ? ({ children, onSelect }: { children?: React.ReactNode; onSelect?: () => void }) => <button onClick={onSelect}>{children}</button>
      : pass }),
    "@/edition/slots": { GenerationAtelier: () => <div data-generation-atelier /> },
    "@/edition/edition": { useEdition: () => ({ features: { imageGeneration: true } }) },
    "./panels": new Proxy({}, { get: (_target, name) => name === "AiChatPanel" ? Ai : name === "PlaytestPanel" ? Playtest : name === "ModulesPanel" ? () => <div data-modules-panel /> : () => null }),
    "./panels/blueprint-panel": { BlueprintCanvasCore: Canvas },
    // The player view owns its own chrome now, so the stage hands it the two
    // controls it used to keep for itself: the way out, and the assistant.
    "./panels/inspector/frontend-page": {
      FrontendPage: ({ immersive, assistant }: { immersive?: boolean; assistant?: { open: boolean; toggle: () => void } }) => (
        <div data-frontend-page data-immersive={immersive ? "" : undefined}>
          <button data-frontend-ai onClick={assistant?.toggle}>assistant</button>
        </div>
      ),
    },
    "./panels/code-view-panel": { setPendingCodeJump: () => {} }, "./stage-tree": { StageTree: () => null },
    // Where the assistant is working is drawn by its own layer and tested on its own.
    "./ai-presence": { AiPresenceLayer: () => null },
    "./lib/agent-presence": { useAgentPresence: () => {} },
  };
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("./blueprint-stage.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module = { exports: {} as { BlueprintStage: React.ComponentType<{ renderReviewPanel: () => { title: string; node: React.ReactNode } }> } };
  new Function("require", "module", "exports", compiled)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const resize = async (width: number) => { workspaceWidth = width; await act(async () => observers.forEach(observer => observer())); };
  const companion = () => dom.window.document.querySelector<HTMLElement>("[data-studio-companion]")!;
  const click = async (element: Element) => { await act(async () => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))); };
  // The assistant is a docked tab beside the canvas; the side column is the
  // playtest's alone. What is clicked on the board opens on the board.
  const dockTabs = () => [...dom.window.document.querySelectorAll(".dv-tab")].map(tab => tab.textContent?.trim());
  const parked = (el: Element | null) => !!el?.closest("[data-dock-parking]");
  // The toolbar button is there only while the assistant is away; open, it
  // is closed from its own heading (the toggle the stage hands the store).
  const aiToggle = () => dom.window.document.querySelector('button[aria-pressed][title="studio.panels.aiAssistant"]')!;
  const closeAi = async () => {
    assert.equal(dom.window.document.querySelector('button[aria-pressed][title="studio.panels.aiAssistant"]'), null, "no toolbar button beside an open assistant");
    await act(async () => studio.stageAssistant!.toggle());
  };
  try {
    await act(async () => root.render(<module.exports.BlueprintStage renderReviewPanel={() => ({ title: "Review", node: null })} />));
    const canvas = dom.window.document.querySelector("[data-canvas-sentinel]");
    // The assistant starts open for editable cards, in its own docked tab.
    const ai = dom.window.document.querySelector("[data-ai-composer]");
    assert.ok(dockTabs().includes("studio.panels.aiAssistant"));
    assert.equal(parked(ai), false);

    assert.equal(companion().dataset.studioCompanionLayout, "closed");
    await closeAi();
    assert.equal(dockTabs().includes("studio.panels.aiAssistant"), false, "closing the assistant closes its tab");
    assert.equal(dom.window.document.querySelector("[data-ai-composer]"), ai, "and keeps it mounted, draft and all");
    assert.equal(parked(ai), true);

    await click(aiToggle());
    assert.ok(dockTabs().includes("studio.panels.aiAssistant"), "its button brings it back");
    // The entry must stay in the canvas's stacking context, with AI usable.
    await act(async () => canvasProps.onDrillPanel("modules", { focus: true }));
    const entryPage = dom.window.document.querySelector<HTMLElement>("[data-stage-focus-page]")!;
    assert.ok(entryPage.closest("[data-canvas-workspace]"), "the entry never portals over the assistant or shell");
    assert.ok(!entryPage.classList.contains("fixed"));
    assert.ok(!ai?.closest("[data-canvas-workspace]"), "AI remains outside the canvas overlay");
    assert.equal(canvasProps.active, false, "covered canvas keyboard actions are disabled");
    await closeAi();
    let clearedSelection = 0;
    const clear = () => { clearedSelection++; };
    window.addEventListener("yumina:studio-canvas-clear-selection", clear);
    for (const eventName of ["yumina:studio-ask", "yumina:studio-ai-send", "yumina:studio-attach-block"]) {
      await act(async () => window.dispatchEvent(new CustomEvent(eventName, { detail: {} })));
    }
    window.removeEventListener("yumina:studio-canvas-clear-selection", clear);
    assert.equal(clearedSelection, 0, "asking AI preserves the entry selection");
    assert.equal(dom.window.document.querySelector("[data-stage-focus-page]"), entryPage);
    assert.equal(parked(ai), false, "AI can be reopened from the entry");
    (ai as HTMLTextAreaElement).focus();
    await act(async () => ai!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(dom.window.document.querySelector("[data-stage-focus-page]"), entryPage, "Escape in AI does not dismiss the entry");
    let entryBackHandled = false;
    await act(async () => { entryBackHandled = !window.dispatchEvent(new Event("yumina:studio-back", { cancelable: true })); });
    assert.equal(entryBackHandled, true, "the shell Back closes the entry before leaving Studio");
    assert.equal(dom.window.document.querySelector("[data-stage-focus-page]"), null);
    assert.equal(canvasProps.active, true);
    assert.equal(canvasMounts, 1);
    assert.equal(aiMounts, 1);
    // The page switch lives in the shell's top bar now; it writes the store.
    await act(async () => studio.setStagePage("frontend"));
    assert.ok(dom.window.document.querySelector("[data-frontend-page]"));
    assert.equal(companion().dataset.studioCompanionLayout, "closed", "frontend uses its own inspector and receives no side column");
    // The player view takes the whole frame: the rail and the page tabs stand
    // down, and the page is handed the one control that has to exist inside a
    // mode you can be in.
    assert.ok(dom.window.document.querySelector("[data-frontend-page][data-immersive]"), "the player view is told it owns the screen");
    assert.equal(dom.window.document.querySelector('[data-onboarding="editors"]'), null, "the canvas's own row is gone while the card has the frame");
    assert.equal(dom.window.document.querySelector("[data-stage-rail]"), null, "so is the rail");
    await click(dom.window.document.querySelector("[data-frontend-ai]")!);
    assert.ok(dockTabs().includes("studio.panels.aiAssistant"), "the assistant docks beside the frontend page instead of covering it");
    assert.equal(dom.window.document.querySelector("[data-ai-composer]"), ai);
    assert.equal(parked(ai), false);
    // The top bar's ← is the one way back; from the player view it goes one
    // step, to the board.
    let stepped = false;
    await act(async () => { stepped = !dom.window.dispatchEvent(new dom.window.Event("yumina:studio-back", { cancelable: true })); });
    assert.equal(stepped, true, "the player view claims the back step");
    assert.equal(dom.window.document.querySelector("[data-frontend-page]"), null, "the corner control leaves the player view");
    assert.ok(dom.window.document.querySelector('[data-onboarding="editors"]'), "and the frame comes back with it");
    assert.ok(dockTabs().includes("studio.panels.aiAssistant"), "coming back to the board never puts the assistant away");

    await act(async () => { studio.mode = "playtest"; emit(); });
    // A playtest is the player's screen across the whole frame, over the
    // board (which stays mounted underneath), not a docked tab beside it.
    assert.equal(dockTabs().includes("studio.panels.playtest"), false, "a playtest is not a docked tab");
    assert.ok(dom.window.document.querySelector("[data-playtest]"));
    assert.equal(companion().dataset.studioCompanion, "playtest");
    assert.match(companion().className, /absolute inset-0/, "it covers the frame");
    await resize(1280);
    assert.equal(playtestMounts, 1, "resizing must not restart a playtest");
    assert.equal(canvasMounts, 1);
    assert.equal(aiMounts, 1);
    assert.equal(dom.window.document.querySelector("[data-canvas-sentinel]"), canvas);
    await act(async () => window.dispatchEvent(new CustomEvent("yumina:studio-learn-panel", { detail: {panelId:"modules",canvasTarget:"memory"} })));
    assert.ok(dom.window.document.querySelector("[data-modules-panel]"), "a missing memory node falls back to modules after stage routing");
    assert.equal(studio.mode, "edit");
    await act(async () => window.dispatchEvent(new CustomEvent("yumina:studio-learn-panel", { detail: {panelId:"first-message",canvasTarget:"opening"} })));
    assert.equal(dom.window.document.querySelector("[data-modules-panel]"), null);
    assert.equal(canvasProps.active, true, "opening lesson returns to the existing canvas");
    assert.equal(canvasMounts, 1, "learning never replaces the canvas");
    await act(async () => { learning.step = "setting"; emit(); });
    assert.equal(companion().dataset.studioCompanionLayout, "closed", "the guide stands on the canvas beside its block; a lesson opens no column");
    assert.equal(dockTabs().includes("studio.panels.aiAssistant"), false, "the assistant stays out of the way of a lesson about the canvas");
    assert.equal(dom.window.document.querySelector("[data-ai-composer]"), ai, "while staying mounted");
    assert.equal(canvasProps.active, true, "the blueprint stays visible during teaching");
    await act(async () => { learning.step = "assistant"; window.dispatchEvent(new CustomEvent("yumina:studio-learn-panel", { detail: { panelId: "ai-chat" } })); emit(); });
    assert.ok(dockTabs().includes("studio.panels.aiAssistant"));
    assert.equal(parked(ai), false);
    assert.equal(dom.window.document.querySelector('[data-ai-composer]'), ai, "guide transitions retain the existing assistant and its draft");
    assert.equal(canvasMounts, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
