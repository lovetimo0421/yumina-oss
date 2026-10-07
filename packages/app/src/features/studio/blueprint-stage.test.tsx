import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React, { act, useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import ts from "typescript";
import * as inspectorLayout from "./lib/stage-inspector-layout";

test("the real stage keeps one mounted canvas, inspector and assistant across docked tools, overlays and frontend visits", async () => {
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
  dom.window.localStorage.setItem("yumina-stage-inspector-width", "500");

  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  const learning = { step: null as string | null, setInspecting: (_inspecting: boolean) => {} };
  const editor = { serverWorldId: "card", worldDraft: { id: "card" }, variants: [], readOnlyInspect: false, guestMode: false, activeSection: "entries", pendingFocus: null, setActiveSection: (section:string) => { editor.activeSection = section; emit(); } };
  const studio = { mode: "edit", setMode: (mode:string) => { studio.mode = mode; emit(); }, stagePage: "blueprint", setStagePage: (page:string) => { studio.stagePage = page; emit(); }, setStageAssistant: () => {} };
  function store<S extends object>(state: S) {
    return Object.assign((selector: (value: S) => unknown) => useSyncExternalStore(
      listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => selector(state)),
    { getState: () => state, subscribe: () => () => {} });
  }
  let canvasMounts = 0, aiMounts = 0, playtestMounts = 0;
  let canvasProps!: { onInspectorChange: (open: boolean) => void; inspectorHost: HTMLDivElement | null; onDrillPanel: (id: string) => void; active: boolean };
  function Canvas(props: typeof canvasProps) {
    canvasProps = props;
    useEffect(() => { canvasMounts++; }, []);
    useEffect(() => {
      const clear = () => props.onInspectorChange(false);
      window.addEventListener("yumina:studio-canvas-clear-selection", clear);
      return () => window.removeEventListener("yumina:studio-canvas-clear-selection", clear);
    }, [props.onInspectorChange]);
    useEffect(() => {
      const learn = (event: Event) => {
        const target = (event as CustomEvent<{canvasTarget:string}>).detail.canvasTarget;
        if (target === "memory") props.onDrillPanel("modules"); // no module yet
      };
      window.addEventListener("yumina:studio-learn-canvas", learn);
      return () => window.removeEventListener("yumina:studio-learn-canvas", learn);
    }, [props.onDrillPanel]);
    return <div data-canvas-sentinel>{props.inspectorHost && createPortal(<button data-inspector-close onClick={() => props.onInspectorChange(false)}>Close inspector</button>, props.inspectorHost)}</div>;
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
    "./lib/stage-inspector-layout": inspectorLayout,
    // Where the assistant is working is drawn by its own layer and tested on its own.
    "./ai-presence": { AiPresenceLayer: () => null },
    "./lib/agent-presence": { useAgentPresence: () => {} },
  };
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("./blueprint-stage.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module = { exports: {} as { BlueprintStage: React.ComponentType<{ renderReviewPanel: () => { title: string; node: React.ReactNode } }> } };
  new Function("require", "module", "exports", compiled)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const root = createRoot(dom.window.document.getElementById("root")!);
  const resize = async (width: number) => { workspaceWidth = width; await act(async () => observers.forEach(observer => observer())); };
  const companion = () => dom.window.document.querySelector<HTMLElement>("[data-studio-companion]")!;
  const click = async (element: Element) => { await act(async () => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))); };
  // The assistant and the playtest are docked tabs beside the canvas now; the
  // side column is the inspector's alone.
  const dockTabs = () => [...dom.window.document.querySelectorAll(".dv-tab")].map(tab => tab.textContent?.trim());
  const parked = (el: Element | null) => !!el?.closest("[data-dock-parking]");
  const aiToggle = () => dom.window.document.querySelector('button[aria-pressed][title="studio.panels.aiAssistant"]')!;
  try {
    await act(async () => root.render(<module.exports.BlueprintStage renderReviewPanel={() => ({ title: "Review", node: null })} />));
    const canvas = dom.window.document.querySelector("[data-canvas-sentinel]");
    // The assistant starts open for editable cards, in its own docked tab.
    const ai = dom.window.document.querySelector("[data-ai-composer]");
    assert.ok(dockTabs().includes("studio.panels.aiAssistant"));
    assert.equal(parked(ai), false);

    assert.equal(companion().dataset.studioCompanionLayout, "closed");
    await click(aiToggle());
    assert.equal(dockTabs().includes("studio.panels.aiAssistant"), false, "closing the assistant closes its tab");
    assert.equal(dom.window.document.querySelector("[data-ai-composer]"), ai, "and keeps it mounted, draft and all");
    assert.equal(parked(ai), true);

    await act(async () => canvasProps.onInspectorChange(true));
    const inspector = dom.window.document.querySelector("[data-inspector-close]");
    assert.equal(companion().dataset.studioCompanionLayout, "overlay");
    assert.match(companion().className, /absolute/);
    assert.equal(companion().style.width, "500px");
    await resize(420);
    assert.equal(companion().style.width, "352px");
    assert.equal(localStorage.getItem("yumina-stage-inspector-width"), "500", "responsive constraints never overwrite the saved width");
    await resize(1280);
    assert.equal(companion().dataset.studioCompanionLayout, "column");
    assert.equal(companion().style.width, "500px");
    assert.equal(dom.window.document.querySelector("[data-inspector-close]"), inspector, "changing placement retains the single inspector portal");
    const separator = companion().querySelector("[role=separator]")!;
    await act(async () => separator.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    assert.equal(companion().style.width, "480px");
    assert.equal(localStorage.getItem("yumina-stage-inspector-width"), "480");

    await resize(780);
    await act(async () => window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(companion().dataset.studioCompanionLayout, "closed");
    await act(async () => canvasProps.onInspectorChange(true));
    await click(dom.window.document.querySelector("[data-inspector-close]")!);
    assert.equal(companion().dataset.studioCompanionLayout, "closed", "the inspector's existing close control also dismisses the temporary overlay");
    await act(async () => canvasProps.onInspectorChange(true));
    // The page switch lives in the shell's top bar now; it writes the store.
    await act(async () => studio.setStagePage("frontend"));
    assert.ok(dom.window.document.querySelector("[data-frontend-page]"));
    assert.equal(companion().dataset.studioCompanionLayout, "closed", "frontend uses its own inspector and receives no global selection column");
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
    assert.equal(dockTabs().includes("studio.panels.aiAssistant"), false, "the restored inspector temporarily puts the assistant away");

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
    // Finish inspecting before the canvas lesson; assistant lessons clear the
    // selection themselves when they open the assistant.
    await act(async () => canvasProps.onInspectorChange(false));
    await act(async () => { learning.step = "setting"; emit(); });
    assert.equal(companion().dataset.studioCompanionLayout, "closed", "the guide stands on the canvas beside its block; a lesson opens no column");
    assert.equal(dockTabs().includes("studio.panels.aiAssistant"), false, "the assistant stays out of the way of a lesson about the canvas");
    assert.equal(dom.window.document.querySelector("[data-ai-composer]"), ai, "while staying mounted");
    await act(async () => canvasProps.onInspectorChange(true));
    assert.equal(dom.window.document.querySelectorAll('[data-studio-companion]').length, 1, "node settings never create a second side column");
    assert.equal(companion().dataset.studioCompanion, "inspector");
    assert.equal(canvasProps.active, true, "inspecting a node leaves the blueprint visible during teaching");
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
