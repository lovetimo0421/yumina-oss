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

test("a variable's player-screen switch can undo a legacy list without deleting its data or base frontend", async () => {
  const variable = { id: "room-type-roster", name: "Room Type Roster", type: "json" as const, defaultValue: [{ id: "mana-condenser", label: "Mana Condenser" }] };
  const base = { file: "_base.tsx" };
  await withInspector(world({ variables: [variable], uiDoc: {
    version: 1, entryPageId: "main", base,
    pages: [{ id: "main", name: "Main", height: 812, elements: [
      { id: "legacy-roster", type: "list", x: 16, y: 16, w: 250, h: 160, source: { kind: "variable", variableId: variable.id }, item: { template: "{{item}}" } },
      { id: "keep", type: "text", x: 16, y: 400, w: 100, h: 20, text: { template: "My custom title" } },
    ] }],
  } }), "var:room-type-roster", {}, async ({ container, click }) => {
    const toggle = () => container.querySelector<HTMLButtonElement>('[data-testid="show-on-screen"]')!;
    assert.ok(toggle(), "the enabled control remains a button");
    assert.equal(toggle().getAttribute("role"), "switch");
    assert.equal(toggle().getAttribute("aria-checked"), "true");
    await click(toggle());
    assert.equal(toggle().getAttribute("aria-checked"), "false");
    assert.deepEqual(useEditorStore.getState().worldDraft.uiDoc?.pages[0]?.elements.map(el => el.id), ["keep"]);
    assert.deepEqual(useEditorStore.getState().worldDraft.variables, [variable]);
    assert.deepEqual(useEditorStore.getState().worldDraft.uiDoc?.base, base);
    await click(toggle());
    assert.equal(toggle().getAttribute("aria-checked"), "true");
    await click(toggle());
    assert.deepEqual(useEditorStore.getState().worldDraft.uiDoc?.pages[0]?.elements.map(el => el.id), ["keep"]);
  });
});


test("repeated text and list display switches restore the native transcript at both widths", async () => {
  for (const type of ["string", "json"] as const) {
    const variable = { id: "roster", name: "Roster", type, defaultValue: type === "json" ? [{ label: "Mana Condenser" }] : "Forest" };
    const transcript = { id: "messages", type: "messages" as const, x: 0, y: 0, w: 375, h: 704, desktop: { x: 16, y: 0, w: 992, h: 600 } };
    await withInspector(world({ variables: [variable], uiDoc: {
      version: 1, entryPageId: "main", pages: [{ id: "main", name: "Main", height: 812, elements: [transcript] }],
    } }), "var:roster", {}, async ({ container, click }) => {
      const toggle = () => container.querySelector<HTMLButtonElement>('[data-testid="show-on-screen"]')!;
      for (let cycle = 0; cycle < 3; cycle++) {
        await click(toggle());
        const shown = useEditorStore.getState().worldDraft.uiDoc!.pages[0].elements.find(el => el.id === "messages")!;
        assert.ok(shown.y > 0);
        await click(toggle());
        const restored = useEditorStore.getState().worldDraft.uiDoc!.pages[0].elements.find(el => el.id === "messages")!;
        assert.equal(restored.y, transcript.y);
        assert.equal(restored.h, transcript.h);
        assert.deepEqual(restored.desktop, transcript.desktop);
      }
      assert.deepEqual(useEditorStore.getState().worldDraft.variables, [variable]);
    });
  }
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
    assert.deepEqual([...container.querySelectorAll("[data-ai-type-option]")].map(b => `${b.getAttribute("data-ai-type-option")}${b.getAttribute("aria-checked") === "true" ? "*" : ""}`), ["turn*", "ui", "event", "custom"]);
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

test("an AI a button calls offers no wires: they never reach it, and it gets none when picked", async () => {
  const fresh = { id: "new", name: "New AI", order: 0, activation: { mode: "always" as const }, station: { kind: "narrator" as const, onClose: "keep" as const } };
  await withInspector(world({ worldbooks: [fresh] }), "module:new", {}, async ({ container, click }) => {
    assert.ok(container.querySelector("[data-testid='station-inputs-entry']"), "one that answers the player reads wires");
    await click(container.querySelector<HTMLButtonElement>("[data-ai-type-option='ui']")!);
    const ui = useEditorStore.getState().worldDraft.worldbooks?.[0]?.station;
    assert.deepEqual(ui?.trigger, { on: "ui" });
    assert.equal(ui?.inputs, undefined, "no conversation wired in behind the creator's back");
    assert.equal(container.querySelector("[data-testid='station-inputs-entry']"), null, "no wires offered");
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

const blur = async (element: HTMLElement) => { await act(async () => { element.focus(); element.blur(); }); };
const radio = (container: HTMLElement, group: string, label: string) =>
  [...container.querySelectorAll(`[role="radiogroup"][aria-label="${group}"] [role="radio"]`)].find(el => el.textContent === label) as HTMLButtonElement;

test("the history window is one choice: 全部 clears the summary too, and a summary without a window never reads as 0", async () => {
  // What the card form used to leave behind: 全部 there cleared only the limit.
  await withInspector(world({ settings: { storySummary: { enabled: true } } }), blockId.context(), {}, async ({ container, click }) => {
    const group = "blueprint.insp.historyLimit";
    assert.equal(radio(container, group, "blueprint.insp.historySummaryShort").getAttribute("aria-checked"), "true");
    assert.match(container.textContent!, /blueprint\.turnCtx\.historyAll/, "the whole budget, not 最新 0 条");
    assert.doesNotMatch(container.textContent!, /previewHistoryLatest/);
    await click(radio(container, group, "blueprint.insp.historyAll"));
    const settings = useEditorStore.getState().worldDraft.settings;
    assert.equal(settings.historyLimit, undefined);
    assert.equal(settings.storySummary, undefined);
    assert.equal(useEditorStore.getState()._past.length, 1, "both halves are one edit");
    assert.equal(radio(container, group, "blueprint.insp.historyAll").getAttribute("aria-checked"), "true");
  });
});

test("numbers are typed freely and settled when let go of", async () => {
  const reaction = { id: "rx", name: "Rx", when: { eventType: "turn:end" }, conditions: [], conditionLogic: "all" as const, then: [], priority: 0, enabled: true };
  await withInspector(world({ reactions: [reaction] as never, settings: { historyLimit: 20 } }), "reaction:rx", {}, async ({ container, field, button, click, input, update }) => {
    await click(button("Advanced"));
    const priority = field("behaviors.priority") as HTMLInputElement;
    // A negative priority used to be impossible: "-" alone read as 0 and
    // was clamped before the digit arrived.
    await input(priority, "-5");
    assert.equal(useEditorStore.getState().worldDraft.reactions?.[0]?.priority, 0, "nothing is written mid-typing");
    await blur(priority);
    assert.equal(useEditorStore.getState().worldDraft.reactions?.[0]?.priority, -5);
    // Typed and then the column moves on without a blur (Escape closes the
    // floating card): what was typed is still kept.
    await input(field("behaviors.chance") as HTMLInputElement, "40");
    await update({}, blockId.context());
    assert.equal(useEditorStore.getState().worldDraft.reactions?.[0]?.chance, 40);
    // Cleared and typed again, the window is what was typed, not 1 then 15.
    const count = field("blueprint.insp.historyLatestCount") as HTMLInputElement;
    await input(count, "");
    await input(count, "5");
    await blur(count);
    assert.equal(useEditorStore.getState().worldDraft.settings.historyLimit, 5);
    await input(count, "9000");
    await act(async () => count.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.equal(useEditorStore.getState().worldDraft.settings.historyLimit, 500, "clamped once, when it is committed");
    assert.ok(container);
  });
});

test("an AI is renamed in its title, by the name it is shown and called by", async () => {
  const yard = { id: "yard", name: "Backyard", order: 0, activation: { mode: "always" as const }, station: { kind: "narrator" as const, name: "Innkeeper", onClose: "keep" as const } };
  await withInspector(world({ worldbooks: [yard] }), "ai:yard", {}, async ({ field, input }) => {
    const name = field("Name") as HTMLInputElement;
    assert.equal(name.value, "Innkeeper");
    await input(name, "Landlady");
    await act(async () => new Promise(resolve => setTimeout(resolve, 350)));
    const book = useEditorStore.getState().worldDraft.worldbooks?.[0];
    assert.equal(book?.station?.name, "Landlady");
    assert.equal(book?.name, "Backyard", "the place it lives in keeps its own name");
  });
});

test("changing a variable's type takes the hidden settings of the old type with it", async () => {
  const mood = { id: "mood", name: "Mood", type: "string" as const, defaultValue: "calm", options: ["calm", "angry"], precise: true };
  await withInspector(world({ variables: [mood] }), "var:mood", {}, async ({ container, click }) => {
    await click(radio(container, "Type", "JSON"));
    const after = useEditorStore.getState().worldDraft.variables[0]!;
    assert.equal(after.precise, undefined, "a list has no precise tracking to keep on out of sight");
    assert.deepEqual(after.options, ["calm", "angry"], "the value list stays for if it becomes text again");
  });
  const hp = { id: "hp", name: "HP", type: "number" as const, defaultValue: 10, precise: true, deltaDown: 5, deltaUp: 5 };
  await withInspector(world({ variables: [hp] }), "var:hp", {}, async ({ container, click }) => {
    await click(radio(container, "Type", "Text"));
    const after = useEditorStore.getState().worldDraft.variables[0]!;
    assert.equal(after.precise, undefined);
    assert.equal(after.deltaDown, undefined);
    assert.equal(after.deltaUp, undefined);
  });
});

test("an opening's seed keyed by the variable's name shows its value; a list's seed is shown, not offered", async () => {
  const opening = entry("town", { role: "greeting", initialVariables: { Health: 50, Bag: "[]" } });
  const draft = world({ entries: [opening], variables: [
    { id: "hp", name: "Health", type: "number", defaultValue: 100 },
    { id: "bag", name: "Bag", type: "json", defaultValue: [] },
  ] });
  useEditorStore.setState({ worldDraft: draft, readOnlyInspect: false, _past: [], _future: [] });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const patches: unknown[] = [];
  const show = (edgeId: string) => act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(BlueprintInspector, {
    target: { type: "edge", edgeId, describe: "wire" }, world: draft, readOnly: false, onPatch: patch => patches.push(patch), onDrill: () => {}, onClose: () => {},
  }))));
  try {
    await show("e:greeting:town->var:hp");
    const value = container.querySelector("input") as HTMLInputElement;
    assert.equal(value.value, "50");
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(value, "60"); value.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await blur(value);
    assert.deepEqual(patches, [{ op: "update-edge", edgeId: "e:greeting:town->var:hp", data: { value: 60 } }]);
    await show("e:greeting:town->var:bag");
    assert.equal(container.querySelector("input"), null, "no box whose edits would vanish");
    assert.match(container.textContent!, /blueprint\.inspector\.seedJsonFixed/);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a prompt piece's condition value is read as its variable keeps it, and a piece needs a variable to hang on", async () => {
  const station = { kind: "worker" as const, trigger: { on: "ui" as const }, pieces: [{ conditions: [{ variableId: "room", operator: "eq" as const, value: "" }], text: "Inside" }] };
  const ai = { id: "guide", name: "Guide", order: 0, activation: { mode: "always" as const }, station };
  await withInspector(world({ worldbooks: [ai], variables: [
    { id: "room", name: "Room", type: "string", defaultValue: "1" },
    { id: "heat", name: "Heat", type: "number", defaultValue: 0 },
  ] }), "ai:guide", {}, async ({ container, input, change }) => {
    const value = () => container.querySelector('[data-ai-custom] input[aria-label="blueprint.inspector.value"]') as HTMLInputElement;
    const condition = () => useEditorStore.getState().worldDraft.worldbooks?.[0]?.station?.pieces?.[0]?.conditions[0];
    await input(value(), "1");
    await blur(value());
    assert.equal(condition()?.value, "1", "a text's 1 stays text, or it never equals the variable");
    await change(value().parentElement!.querySelector("select")!, "heat");
    assert.equal(condition()?.value, 1, "moved onto a number, the value is read as one");
    await input(value(), "0.");
    assert.equal(value().value, "0.", "a decimal can be typed through its point");
    await input(value(), "0.5");
    await blur(value());
    assert.equal(condition()?.value, 0.5);
  });
  await withInspector(world({ worldbooks: [{ ...ai, station: { ...station, pieces: undefined, say: "none" } }] }), "ai:guide", {}, async ({ container }) => {
    const add = container.querySelector<HTMLButtonElement>("[data-ai-piece-add]")!;
    assert.equal(add.disabled, true, "no piece pointing at no variable");
  });
});

test("the card's own AI shows every kind, and picking another adds that AI beside it", async () => {
  await withInspector(world(), "ai:narrator", {}, async ({ container, click }) => {
    const options = [...container.querySelectorAll("[data-ai-type-option]")];
    assert.deepEqual(options.map(b => `${b.getAttribute("data-ai-type-option")}${b.hasAttribute("data-ai-type-adds") ? "+" : ""}`), ["turn", "ui+", "event+", "custom+"]);
    assert.equal(container.textContent?.includes("blueprint.insp.openContext"), false, "Context is its own block, not a link from here");
    const before = (a: Element | null, b: Element | null) => !!a && !!b && !!(a.compareDocumentPosition(b) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(before(container.querySelector("[role='radiogroup'][aria-label='blueprint.storyAi.sampling']"), container.querySelector("[data-ai-type-pick]")), "who sets its settings comes first");
    const asked: unknown[] = [];
    const onAdd = (e: Event) => asked.push((e as CustomEvent).detail);
    dom.window.addEventListener("yumina:studio-add-ai", onAdd);
    await click(container.querySelector("[data-ai-type-option='custom']")!);
    dom.window.removeEventListener("yumina:studio-add-ai", onAdd);
    assert.deepEqual(asked, [{ type: "custom" }]);
    assert.deepEqual(useEditorStore.getState().worldDraft.worldbooks, [], "the card's own AI is left as it is");
  });
});

test("a custom AI is declared as an interface: its call, what it is handed, what it answers, what it should do", async () => {
  const phone = { id: "phone", name: "Phone", order: 0, host: "card", activation: { mode: "always" as const }, station: { kind: "custom" as const, name: "Mina", output: [{ name: "reply", type: "text" as const }, { name: "mood", type: "choice" as const, options: ["warm", "cold"] }] } };
  await withInspector(world({ worldbooks: [phone] }), "ai:phone", {}, async ({ container }) => {
    const snippet = container.querySelector("[data-ai-contract] [data-ai-call-snippet]")?.textContent ?? "";
    assert.match(snippet, /api\.callAi\("Mina", input\)/);
    assert.match(snippet, /mood: "warm" \| "cold"/);
    assert.ok(container.querySelector("[data-ai-takes]"), "what it is handed");
    assert.ok(container.querySelector("[data-ai-does]"), "what it should do, for whoever implements it");
    assert.ok(container.querySelector("[data-ai-custom]"), "its answer format is right there");
    assert.equal(container.querySelectorAll("[data-ai-call-snippet]").length, 1, "the call is written once");
    const first = container.querySelector("[data-ai-model-first] [data-station-params]");
    assert.ok(first && first.compareDocumentPosition(container.querySelector("[data-ai-type-pick]")!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "who sets its settings comes first");
    assert.equal(container.querySelectorAll("[data-station-model-fields]").length, 1, "the model is shown once");
  });
});
