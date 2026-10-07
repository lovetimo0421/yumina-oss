import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement, type ComponentProps } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { blockId, toGraph, type WorldDefinition, type WorldEntry } from "@yumina/engine";
import { resolveCanvasInspectorNode } from "./canvas-inspector-target";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: "http://localhost" });
const globals = { window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const vite = await createServer({
  configFile: false, root: fileURLToPath(new URL("../../../../..", import.meta.url)), appType: "custom", logLevel: "silent",
  resolve: { alias: { "@": fileURLToPath(new URL("../../../..", import.meta.url)), "@yumina/engine": fileURLToPath(new URL("../../../../../../engine/src/index.ts", import.meta.url)) } },
  esbuild: { jsx: "automatic" }, server: { middlewareMode: true },
});
const { BlueprintInspector } = await vite.ssrLoadModule("/src/features/studio/panels/blueprint/inspector.tsx") as typeof import("./inspector");
const { useEditorStore } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("@/stores/editor");
const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { editor: {
  entries: { name: "Name", content: "Content", alwaysSend: "Always send", advanced: "Advanced" },
  firstMessage: { initialVarsTitle: "Opening initial state", initialVarsReadonlyHint: "Overrides for this opening", noInitialVars: "Uses variable defaults", editInVariables: "Edit in variables", true: "True", false: "False" },
  variables: { types: { number: "Number", string: "Text", boolean: "Switch", json: "Structured data" }, aiAccessLabel: "AI access", activationLabel: "Activation" },
  blueprint: { row: { varType: { number: "Number", string: "Text", boolean: "Switch", json: "JSON" } }, insp: { editCanvasContent: "Edit text on canvas", variableName: "Variable name", type: "Type", startsAt: "Initial value", typeHint: { number: "Numbers such as health 100", string: "Text such as a location", boolean: "A switch: true or false", json: "A list or object" }, aiUse: "AI and activation", module: "Module", enabled: "Enabled", keywords: "Keywords", readOnly: "Read only" }, entry: { adjustDelivery: "Adjust activation" }, rowEdit: { sectionLabel: "Inject into" } },
} } } });
after(async () => {
  await vite.close();
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

const entry = (id: string, extra: Partial<WorldEntry> = {}): WorldEntry => ({ id, name: id, role: "custom", content: `Story ${id}`, section: "system-presets", position: 0, enabled: true, alwaysSend: true, keywords: [], conditions: [], conditionLogic: "all", ...extra });
const world = (extra: Partial<WorldDefinition> = {}): WorldDefinition => ({ id: "card", name: "Card", description: "", author: "", version: "1", settings: {}, entries: [], variables: [], rules: [], reactions: [], components: [], customUI: [], audioTracks: [], worldbooks: [], ...extra });
type Options = Pick<ComponentProps<typeof BlueprintInspector>, "autoFocusName" | "readOnly">;

async function withInspector(initial: WorldDefinition, objectId: string, initialOptions: Partial<Options>, run: (context: {
  container: HTMLElement; edited: string[]; drilled: string[];
  field: (label: string) => HTMLInputElement | HTMLSelectElement;
  button: (label: string) => HTMLButtonElement;
  click: (element: Element) => Promise<void>;
  input: (element: HTMLInputElement, value: string) => Promise<void>;
  change: (element: HTMLSelectElement, value: string) => Promise<void>;
  update: (options: Partial<Options>, id?: string) => Promise<void>;
  replace: (draft: WorldDefinition) => Promise<void>;
}) => Promise<void>) {
  useEditorStore.setState({ worldDraft: initial, serverWorldId: null, isDirty: false, readOnlyInspect: false, _past: [], _future: [], canUndo: false, canRedo: false });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const edited: string[] = [], drilled: string[] = [];
  let selected = objectId, options: Options = { readOnly: false, ...initialOptions };
  function Harness() {
    const draft = useEditorStore(s => s.worldDraft);
    const resolved = resolveCanvasInspectorNode(selected, toGraph(draft, { foldPlainEntries: false }).nodes);
    assert.ok(resolved, `${selected} is projected`);
    const { node, section } = resolved;
    return createElement(BlueprintInspector, { target: { type: "node", node, section, title: node.title, kindLabel: node.kind }, world: draft, ...options, onPatch: () => {}, onDrill: panel => drilled.push(panel), onClose: () => {}, onOpenMemory: id => { selected = blockId.context(id); render(); }, onOpenModule: id => { selected = `module:${id}`; render(); } });
  }
  const render = () => root.render(createElement(I18nextProvider, { i18n }, createElement(Harness)));
  const field = (label: string) => {
    const associated = [...container.querySelectorAll("label")].find(el => el.textContent === label)?.htmlFor;
    const element = (associated ? dom.window.document.getElementById(associated) : null) ?? [...container.querySelectorAll("input, select, button[role=\"switch\"]")].find(el => el.getAttribute("aria-label") === label);
    assert.ok(element, `field ${label} exists`);
    return element as HTMLInputElement | HTMLSelectElement;
  };
  const button = (label: string) => {
    const element = [...container.querySelectorAll("button")].find(el => el.textContent === label);
    assert.ok(element, `button ${label} exists`);
    return element;
  };
  try {
    await act(async () => render());
    await run({ container, edited, drilled, field, button,
      click: async element => { await act(async () => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))); },
      input: async (element, value) => { await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
        element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      }); },
      change: async (element, value) => { await act(async () => { element.value = value; element.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); },
      update: async (updates, id) => { options = { ...options, ...updates }; selected = id ?? selected; await act(async () => render()); },
      replace: async draft => { await act(async () => useEditorStore.setState({ worldDraft: draft })); },
    });
  } finally {
    await act(async () => root.unmount());
    useEditorStore.getState().stopAutosave();
    dom.window.localStorage.clear();
  }
}

test("an entry is written in the column, and a gated one opens showing what gates it", async () => {
  const original = entry("mine", { worldbookId: "chapter", alwaysSend: false, keywords: ["ore"] });
  await withInspector(world({ entries: [original], worldbooks: [{ id: "chapter", name: "Chapter", order: 0, activation: { mode: "always" } }] }), "entry:mine", {}, async ({ container, field, button, click }) => {
    // One editor for one piece of text, and it is this one: the board draws
    // the row, the column writes it.
    assert.equal(container.querySelector("textarea")!.value, original.content);
    // This entry only reaches the AI on a keyword, which is the case its
    // creator has to be able to see without going looking for it.
    assert.equal(button("Adjust activation").getAttribute("aria-expanded"), "true");
    assert.equal(field("Keywords").value, "ore");
    assert.equal(useEditorStore.getState()._past.length, 0);
    await click(field("Always send"));
    assert.equal(useEditorStore.getState().worldDraft.entries[0]!.alwaysSend, true);
    assert.equal(useEditorStore.getState().worldDraft.entries[0]!.content, original.content);
  });
});

test("an entry that always sends keeps its activation folded — there is nothing to explain", async () => {
  const plain = entry("air", { alwaysSend: true });
  await withInspector(world({ entries: [plain] }), "entry:air", {}, async ({ button }) => {
    assert.equal(button("Adjust activation").getAttribute("aria-expanded"), "false");
  });
});

test("opening settings show saved initial overrides and expose the existing variable tool without modifying them", async () => {
  const opening = entry("town", { role: "greeting", initialVariables: { hp: 50, "Has key": false, missing: 7 } });
  await withInspector(world({ entries: [opening], variables: [{ id: "hp", name: "Health", type: "number", defaultValue: 100 }, { id: "key", name: "Has key", type: "boolean", defaultValue: true }] }), "greeting:town", {}, async ({ container, button, click, drilled }) => {
    assert.equal(container.querySelector("textarea")!.value, opening.content);
    assert.match(container.textContent!, /Opening initial state/);
    assert.deepEqual([...container.querySelectorAll("dt")].map(el => el.textContent), ["Health", "Has key", "missing"]);
    assert.deepEqual([...container.querySelectorAll("dd")].map(el => el.textContent), ["50", "False", "7"]);
    await click(button("Edit in variables"));
    assert.deepEqual(drilled, ["variables"]);
    assert.deepEqual(useEditorStore.getState().worldDraft.entries[0], opening);
    assert.equal(useEditorStore.getState()._past.length, 0);
  });
});

test("new variable names are labelled and selected before type and value; later edits do not steal focus", async () => {
  const variable = { id: "hp", name: "New variable", type: "number" as const, defaultValue: 100, aiAccess: "read" as const, activation: { mode: "manual" as const }, min: 0 };
  await withInspector(world({ variables: [variable] }), "var:hp", { autoFocusName: true }, async ({ container, field, button, click, replace }) => {
    const name = field("Variable name") as HTMLInputElement;
    // The kind is a row of four, not a menu: the other three are in view.
    const type = container.querySelector('[role="radiogroup"][aria-label="Type"]') as HTMLElement;
    assert.ok(type, "the type is a row of choices");
    const value = field("Initial value") as HTMLInputElement;
    assert.equal(dom.window.document.activeElement, name);
    assert.equal(name.selectionStart, 0);
    assert.equal(name.selectionEnd, variable.name.length);
    assert.ok(name.compareDocumentPosition(type) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(type.compareDocumentPosition(value) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    // The explanation waits behind ⓘ instead of standing under the field.
    const hint = () => [...container.querySelectorAll("[title]")].map(el => el.getAttribute("title")).join(" | ");
    assert.match(hint(), /Numbers such as health 100/);
    assert.equal(button("AI and activation").getAttribute("aria-expanded"), "false");
    await act(async () => value.focus());
    await replace({ ...useEditorStore.getState().worldDraft, description: "Unrelated edit" });
    assert.equal(dom.window.document.activeElement, value);
    await click([...type.querySelectorAll('[role="radio"]')].find(el => el.textContent === "Switch")!);
    assert.deepEqual(useEditorStore.getState().worldDraft.variables[0], { ...variable, type: "boolean", defaultValue: false });
    assert.match(hint(), /A switch: true or false/);
    assert.equal(useEditorStore.getState()._past.length, 1, "type and its compatible default are one edit");
    await click(button("AI and activation"));
    assert.ok([...container.querySelectorAll("select")].some(el => el.value === "read"));
    assert.ok(container.querySelector('[aria-label="Activation"]'), "advanced activation remains accessible");
  });
});

test("a pending variable rename follows its ID through reordering, and switching objects shows the new name immediately", async () => {
  const first = { id: "hp", name: "Health", type: "number" as const, defaultValue: 100 };
  const second = { id: "gold", name: "Gold", type: "number" as const, defaultValue: 0 };
  await withInspector(world({ variables: [first, second] }), "var:hp", { autoFocusName: true }, async ({ field, input, replace, update }) => {
    await input(field("Variable name") as HTMLInputElement, "Vitality");
    await replace({ ...useEditorStore.getState().worldDraft, variables: [second, first] });
    await act(async () => new Promise(resolve => setTimeout(resolve, 350)));
    assert.deepEqual(useEditorStore.getState().worldDraft.variables.map(v => [v.id, v.name]), [["gold", "Gold"], ["hp", "Vitality"]]);
    await update({}, "var:gold");
    assert.equal(field("Variable name").value, "Gold");
    assert.equal(dom.window.document.activeElement, field("Variable name"));
  });
});

test("a new variable waits for its hidden inspector host, stops after focus, and cancels retries when its target changes or unmounts", async () => {
  const container = dom.window.document.getElementById("root")!;
  const originalFocus = dom.window.HTMLElement.prototype.focus;
  const originalRequest = dom.window.requestAnimationFrame;
  const originalCancel = dom.window.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  // JSDOM does not implement CSS visibility when focusing. Preserve the real
  // inspector and hidden host, adding only the browser's hidden-focus behavior.
  dom.window.HTMLElement.prototype.focus = function (options) {
    if (!this.closest("[hidden]")) originalFocus.call(this, options);
  };
  dom.window.requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, callback); return id; };
  dom.window.cancelAnimationFrame = id => { frames.delete(id); };
  const nextFrame = async () => {
    const pending = [...frames.values()];
    frames.clear();
    await act(async () => pending.forEach(callback => callback(performance.now())));
  };
  const initial = world({ variables: [
    { id: "hp", name: "New variable", type: "number", defaultValue: 100 },
    { id: "gold", name: "Gold", type: "number", defaultValue: 0 },
  ] });
  try {
    container.hidden = true;
    await withInspector(initial, "var:hp", { autoFocusName: true }, async ({ field, replace, update }) => {
      const name = field("Variable name") as HTMLInputElement;
      assert.notEqual(dom.window.document.activeElement, name);
      assert.equal(frames.size, 1, "failed hidden focus schedules another frame");
      await nextFrame();
      assert.notEqual(dom.window.document.activeElement, name);
      assert.equal(frames.size, 1);
      container.hidden = false;
      await nextFrame();
      assert.equal(dom.window.document.activeElement, name);
      assert.equal(name.selectionStart, 0);
      assert.equal(name.selectionEnd, "New variable".length);
      assert.equal(frames.size, 0, "successful focus stops retrying");
      const value = field("Initial value");
      await act(async () => value.focus());
      await replace({ ...useEditorStore.getState().worldDraft, description: "Another edit" });
      await nextFrame();
      assert.equal(dom.window.document.activeElement, value, "ordinary input updates do not restart autofocus");

      container.hidden = true;
      await update({}, "var:gold");
      const cancelledTargetFrame = [...frames.values()][0]!;
      assert.equal(frames.size, 1);
      await update({ autoFocusName: false }, "var:hp");
      assert.equal(frames.size, 0, "switching away cancels the previous target's retry");
      container.hidden = false;
      await act(async () => cancelledTargetFrame(performance.now()));
      assert.notEqual(dom.window.document.activeElement, field("Variable name"), "a stale callback cannot focus the next object's name");
      container.hidden = true;
      await update({ autoFocusName: true }, "var:gold");
      assert.equal(frames.size, 1);
    });
    assert.equal(frames.size, 0, "unmounting cancels a still-hidden inspector's retry");
  } finally {
    container.hidden = false;
    dom.window.HTMLElement.prototype.focus = originalFocus;
    dom.window.requestAnimationFrame = originalRequest;
    dom.window.cancelAnimationFrame = originalCancel;
  }
});

test("read-only selections never expose or autofocus editable variable fields", async () => {
  await withInspector(world({ variables: [{ id: "hp", name: "Health", type: "number", defaultValue: 100 }] }), "var:hp", { autoFocusName: true, readOnly: true }, async ({ container }) => {
    assert.equal(container.querySelector("input, select, textarea"), null);
    assert.match(container.textContent!, /Read only/);
    assert.equal(useEditorStore.getState().isDirty, false);
  });
});


test("memory has its own inspector and changing its scope preserves station behavior and inputs", async () => {
  const station = { kind: "narrator" as const, history: "own" as const, onClose: "archive" as const, archivePrompt: "Keep the ending", model: "test/model", inputs: [{ kind: "transcript" as const, from: "b", limit: 7, as: "lore" as const }] };
  const book = { id: "a", name: "Chapter A", order: 0, activation: { mode: "always" as const }, station };
  await withInspector(world({ worldbooks: [book, { id: "b", name: "Chapter B", order: 1, activation: { mode: "always" } }] }), blockId.context("a"), {}, async ({ container, button, click }) => {
    assert.match(container.textContent!, /blueprint.blocks.context/);
    assert.equal(container.querySelector('input[aria-label="Name"]'), null, "memory title never renames its owning module");
    assert.equal(container.querySelector('input[list]'), null, "model controls remain in module settings");
    assert.equal(container.querySelectorAll("details").length, 3);
    assert.ok([...container.querySelectorAll("details")].every(details => !details.open));
    assert.equal(useEditorStore.getState().isDirty, false);
    assert.equal(container.querySelector("textarea")?.value, station.archivePrompt);
    await click(button("blueprint.station.onClose_keep"));
    assert.deepEqual(useEditorStore.getState().worldDraft.worldbooks?.[0]?.station, { ...station, onClose: "keep" });
    await click(button("blueprint.station.pool.card"));
    const { history: _history, ...rest } = station;
    assert.deepEqual(useEditorStore.getState().worldDraft.worldbooks?.[0]?.station, { ...rest, onClose: "keep" });
    assert.deepEqual(book.station, station, "input definitions remain immutable");
    await click(button("blueprint.insp.openModuleSettings"));
    assert.ok(container.querySelector('input[aria-label="Name"]'));
    // A module with a station is an AI: its settings are who it talks to,
    // when it is there and what it remembers, all on one panel.
    assert.ok(container.querySelector("[data-ai-form]"));
    assert.equal(container.querySelector<HTMLSelectElement>("[data-ai-run-when]")?.value, "reply");
    assert.ok([...container.querySelectorAll("button")].some(element => element.textContent === "blueprint.station.onClose_keep"), "its memory is set here");
    assert.equal(container.textContent?.includes("blueprint.station.takeOver"), false);
    assert.equal(container.querySelector("[data-make-own-ai]"), null, "it has one already");
    assert.deepEqual(useEditorStore.getState().worldDraft.worldbooks?.[0]?.station, { ...rest, onClose: "keep" });
  });
});

test("an AI runs whenever its creator picks, and one going behind the scenes stops waiting for words", async () => {
  const dock = { id: "dock", name: "Dock", order: 0, activation: { mode: "always" as const }, station: { kind: "narrator" as const, onClose: "keep" as const } };
  const fresh = { id: "new", name: "New AI", order: 1, activation: { mode: "keywords" as const, keywords: [], exclusive: true }, station: { kind: "narrator" as const, onClose: "keep" as const } };
  await withInspector(world({ worldbooks: [dock, fresh] }), "module:new", {}, async ({ container, change }) => {
    const runWhen = () => container.querySelector<HTMLSelectElement>("[data-ai-run-when]")!;
    // Turn-based first: inside the type, only its own ways to run.
    assert.deepEqual([...container.querySelectorAll("[data-ai-type-option]")].map(b => `${b.getAttribute("data-ai-type-option")}${b.getAttribute("aria-checked") === "true" ? "*" : ""}`), ["turn*", "ui", "code"]);
    assert.deepEqual([...runWhen().options].map(o => o.value), ["reply", "turns", "after"]);
    await change(runWhen(), "after");
    const after = useEditorStore.getState().worldDraft.worldbooks?.[1];
    assert.deepEqual(after?.station?.trigger, { on: "after", from: "dock" }, "it follows the other AI that answers");
    assert.equal(after?.station?.kind, "worker");
    assert.deepEqual(after?.station?.inputs, [{ kind: "transcript", from: "core", limit: 20 }], "with the conversation to work from");
    assert.deepEqual(after?.activation, { mode: "always" }, "no longer waiting for words nobody wrote");
    await change(runWhen(), "turns");
    assert.deepEqual(useEditorStore.getState().worldDraft.worldbooks?.[1]?.station?.trigger, { on: "turns", every: 3 });
  });
});

test("a place shows its contents and folds the advanced part; an AI comes in by being dragged there", async () => {
  const book = { id: "a", name: "Chapter A", order: 0, activation: { mode: "always" as const } };
  await withInspector(world({ worldbooks: [book] }), "module:a", {}, async ({ container, button, click }) => {
    assert.equal(container.textContent?.includes("blueprint.insp.situationWhat"), false, "no intro sentence over the settings");
    assert.ok([...container.querySelectorAll("details")].some(details => details.open), "what is inside is shown, not folded");
    assert.equal(container.textContent?.includes("blueprint.insp.openMemory"), false, "another AI and its memory wait under 高级");
    assert.equal(container.textContent?.includes("blueprint.ctx.perTurn"), false, "context estimates are not repeated in module settings");
    assert.equal(container.querySelector("[data-ai-form]"), null, "a place is not an AI");
    assert.equal(container.querySelector("[data-place-gives]"), null, "with one AI there is nobody else to name");
    await click(button("blueprint.insp.situationAdvanced"));
    assert.equal(container.textContent?.includes("blueprint.station.takeOver"), false, "taking over is no longer a switch here");
    assert.deepEqual(useEditorStore.getState().worldDraft.worldbooks?.[0], book);
    assert.equal(useEditorStore.getState().isDirty, false);
    assert.equal(container.textContent?.includes("blueprint.aiForm.makeOwn"), false, "no button makes an AI here: it is added outside and dragged in");
  });
});
