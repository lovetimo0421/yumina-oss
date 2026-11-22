import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import ts from "typescript";

test("opening the phone assistant above a lore page retains both editors", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const require = createRequire(import.meta.url);
  const node = { id: "entry:lore", kind: "entry", title: "Lore" };
  const worldDraft = { id: "card", worldbooks: [] };
  const common = {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/lib/utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") },
  };
  function load(file: string, mocks: Record<string, unknown>) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const module = { exports: {} as Record<string, React.ComponentType<any>> };
    new Function("require", "module", "exports", compiled)((id: string) => mocks[id] ?? common[id as keyof typeof common] ?? require(id), module, module.exports);
    return module.exports;
  }
  const MobileBoard = load("./mobile-board.tsx", {
    "@yumina/engine": { blockId: { frontend: "frontend" }, toGraph: () => ({ nodes: [node], edges: [] }) },
    "@/stores/editor": { useEditorStore: (select: (state: unknown) => unknown) => select({ worldDraft, guestMode: false, readOnlyInspect: false, applyGraphPatch: () => {} }) },
    "./panels/blueprint-panel": { BlueprintCanvasCore: ({ phone }: { phone: { onOpen: (id: string) => void } }) => <button data-lore onClick={() => phone.onOpen(node.id)}>Lore</button> },
    "./panels/blueprint/inspector": { BlueprintInspector: () => <textarea data-lore-content defaultValue="Lore draft" /> },
    "./panels/blueprint/canvas-inspector-target": { resolveCanvasInspectorNode: () => ({ node }) },
    "./panels/blueprint/place-ais": { placeAis: () => ({ rows: [] }) },
    "./learn/learning-catalog": { LEARNING_PANEL_EVENT: "test-panel", LEARNING_PHONE_OPEN_EVENT: "test-phone-open" },
    "./components/template-blanks-chip": { TemplateBlanksChip: () => null },
  }).MobileBoard!;
  const PhoneAssistantSheet = load("./phone-assistant-sheet.tsx", {
    "@/stores/studio": { useStudioStore: (select: (state: unknown) => unknown) => select({ isAgentWorking: false, isChatStreaming: false }) },
    "./lib/agent-job": { AI_PRESENCE_EVENT: "test-presence" },
  }).PhoneAssistantSheet!;
  function Harness() {
    const [state, setState] = useState("peek");
    return <main><MobileBoard bottomInset={60} /><PhoneAssistantSheet state={state} onState={setState}>
      <p data-conversation>Assistant conversation</p><textarea data-composer defaultValue="Help with this lore" />
    </PhoneAssistantSheet></main>;
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const click = async (selector: string) => act(async () => document.querySelector<HTMLButtonElement>(selector)!.click());
  try {
    await act(async () => root.render(<Harness />));
    await click("[data-lore]");
    const lore = document.querySelector<HTMLTextAreaElement>("[data-lore-content]")!;
    lore.value = "Unfinished lore edit";
    await click("[data-assistant-bar]");
    const sheet = document.querySelector<HTMLElement>("[data-assistant-sheet]")!;
    const page = document.querySelector<HTMLElement>("[data-mobile-board-page]")!;
    assert.equal(sheet.dataset.assistantSheet, "open");
    assert.equal(document.activeElement, document.querySelector("[data-composer]"));
    // Open follows the frame (the keyboard shrinks it); never a pixel height
    // read at the tap, which stayed full-screen under an Android keyboard.
    assert.equal(sheet.style.height, "100%");
    // These positioned elements share the phone main's stacking context.
    // Assert their real Tailwind layer values; JSDOM cannot paint/hit-test CSS.
    const layer = (element: HTMLElement) => Number(/(?:^|\s)z-(\d+)(?:\s|$)/.exec(element.className)?.[1]);
    assert.ok(layer(sheet) > layer(page), "the conversation must paint above the open lore page");
    const composer = document.querySelector<HTMLTextAreaElement>("[data-composer]")!;
    composer.value = "Keep my AI draft";
    await click("[data-assistant-sheet-close]");
    assert.equal(sheet.dataset.assistantSheet, "peek");
    assert.equal(document.querySelector("[data-lore-content]"), lore);
    assert.equal(lore.value, "Unfinished lore edit");
    await click("[data-assistant-bar]");
    assert.equal(document.querySelector("[data-composer]"), composer);
    assert.equal(composer.value, "Keep my AI draft");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
