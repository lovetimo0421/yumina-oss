import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { portHandleId, rowHandleId, type WorldEntry } from "@yumina/engine";
import type { CanvasWritingNodeData } from "./canvas-writing-node";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: "http://localhost" });
// Keep the actual ReactFlow node and handles. Layout measurements belong to
// browser QA; this observer deliberately avoids pretending JSDOM lays out CSS.
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
const globals = { getComputedStyle: dom.window.getComputedStyle.bind(dom.window), window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, ResizeObserver: ResizeObserverStub, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
Object.defineProperty(dom.window, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
const { createRoot } = await import("react-dom/client");
const { ReactFlow } = await import("@xyflow/react");
const vite = await createServer({ root: fileURLToPath(new URL("../../../../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
const { CanvasWritingNode, canvasWritingNodeHeight } = await vite.ssrLoadModule("/src/features/studio/panels/blueprint/canvas-writing-node.tsx") as typeof import("./canvas-writing-node");
const nodeTypes = { writing: CanvasWritingNode };
const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { editor: { blueprint: {
  starter: { openingTitle: "Opening", settingTitle: "Setting" },
  block: { sharedRow: "shared", sharedRowHint: "One object shared with every module" },
  loose: { badge: "Not in a module yet", hint: "Drag into a module", shareAll: "Put in every module" },
  writing: { entrySettings: "Settings", disabled: "Disabled", configuredDelivery: "Custom activation", moreOpening: "Add opening", moreSetting: "Add setting", emptyOpening: "Nothing written yet", emptySetting: "No text yet", showRelations: "Relationships", relationsFor: "Relationships for {{name}}", expandRow: "Open for editing", collapseRow: "Close", deliveryOff: "Off", deliveryKeywords: "Keywords: {{keywords}}", deliveryConditions: "When {{count}} conditions match", deliveryFrontend: "Interface decides", deliveryAlways: "Sent every turn", deliveryUnset: "No activation set" },
} } } } });
after(async () => {
  await vite.close();
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

const entry = (id: string, extra: Partial<WorldEntry> = {}): WorldEntry => ({ id, name: id, role: "custom", content: `Story ${id}`, section: "system-presets", position: 0, enabled: true, alwaysSend: true, keywords: [], conditions: [], conditionLogic: "all", ...extra });

async function withNode(initial: Partial<CanvasWritingNodeData>, run: (context: {
  container: HTMLElement;
  data: () => CanvasWritingNodeData;
  opened: string[];
  toggled: string[];
  hovered: (string | null)[];
  focused: string[];
  adds: () => number;
  menus: Array<{ id: string; x: number; y: number }>;
  drops: Array<[string, string]>;
  click: (element: Element) => Promise<void>;
  update: (updates: Partial<CanvasWritingNodeData>) => Promise<void>;
}) => Promise<void>) {
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const opened: string[] = [], toggled: string[] = [], hovered: (string | null)[] = [], focused: string[] = [], menus: Array<{ id: string; x: number; y: number }> = [], drops: Array<[string, string]> = [];
  let adds = 0;
  let data: CanvasWritingNodeData = {
    kind: "opening", entries: [], readOnly: false,
    onOpen: id => opened.push(id),
    onToggleExpand: id => toggled.push(id),
    renderEditor: id => createElement("textarea", { "data-test-editor": id }),
    onHoverObject: id => hovered.push(id),
    onFocusEntry: id => focused.push(id),
    onRowContextMenu: (id, event) => menus.push({ id, x: event.clientX, y: event.clientY }),
    onRowDrop: (dragged, target) => drops.push([dragged, target]),
    onAdd: () => { adds++; },
    ...initial,
  };
  const render = () => root.render(createElement(I18nextProvider, { i18n }, createElement(ReactFlow, {
    nodes: [{ id: "writing-node", type: "writing", position: { x: 0, y: 0 }, data, width: data.width ?? 420, height: canvasWritingNodeHeight(data) }],
    edges: [], nodeTypes, style: { width: 900, height: 900 }, onlyRenderVisibleElements: false,
    onError: (code, message) => { if (code !== "004" && code !== "013") throw new Error(message); }, // JSDOM has no CSS layout; all other ReactFlow errors fail.
  })));
  try {
    await act(async () => render());
    await run({
      container, data: () => data, opened, toggled, hovered, focused, menus, drops,
      adds: () => adds,
      click: async element => { await act(async () => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))); },
      update: async updates => { data = { ...data, ...updates }; await act(async () => render()); },
    });
  } finally { await act(async () => root.unmount()); }
}

test("a row offers both ways in: the click keeps the drawer, the chevron opens it here", async () => {
  const setting = entry("worldview", { content: "Ash and salt." });
  await withNode({ kind: "setting", entries: [setting, entry("town")] }, async ({ container, data, toggled, opened, focused, click, update }) => {
    // Shut, a row is a row: nothing to type into until it is opened.
    assert.equal(container.querySelector("textarea"), null);
    const section = container.querySelector('[data-canvas-writing-object="entry:worldview"]')!;
    // The one control that never hides: a row whose contents are behind a
    // hover is a row nobody knows has contents.
    const chevron = section.querySelector('[data-canvas-writing-expand="entry:worldview"]')!;
    assert.equal(chevron.getAttribute("aria-expanded"), "false");
    // The settings button that only re-opened the drawer is gone (the click on
    // the row already did that); so is the relationships one, now in ⋯.
    assert.equal(section.querySelector("[data-canvas-writing-settings]"), null);
    assert.equal(section.querySelector("[data-canvas-writing-relations]"), null);
    // Clicking the row is unchanged: it hands the object to the drawer.
    await click(section.querySelector("[data-canvas-writing-open]")!);
    assert.deepEqual(opened, ["entry:worldview"]);
    assert.deepEqual(focused, ["worldview"]);
    await click(section.querySelector("[data-canvas-writing-preview]")!);
    assert.deepEqual(opened, ["entry:worldview", "entry:worldview"], "so does the line under it");
    assert.deepEqual(toggled, [], "and neither of them opens it in place");
    // The chevron is the other way in, and only the chevron.
    await click(chevron);
    assert.deepEqual(toggled, ["entry:worldview"]);
    assert.equal(opened.length, 2, "opening it here does not also open the drawer");

    await update({ expandedIds: new Set(["entry:worldview"]) });
    const open = container.querySelector('[data-canvas-writing-object="entry:worldview"]')!;
    assert.ok(open.querySelector('[data-canvas-writing-editor="entry:worldview"] textarea'), "an open row holds the object's own editor");
    assert.equal(open.querySelector("[data-canvas-writing-preview]"), null, "and drops the taste of it that the shut row showed");
    assert.equal(open.querySelector('[data-canvas-writing-expand="entry:worldview"]')!.getAttribute("aria-expanded"), "true");
    // The board has to know the row grew, or the module below it is drawn over.
    assert.equal(canvasWritingNodeHeight(data()), 40 + 2 + (40 + 460) + 96);
  });
});

test("detail says when each entry reaches the AI; simple says only its name", async () => {
  const keyworded = entry("gate", { alwaysSend: false, keywords: ["city gate", "guard"] });
  const always = entry("tone");
  await withNode({ kind: "setting", entries: [keyworded, always] }, async ({ container, update }) => {
    const first = container.querySelector('[data-canvas-writing-object="entry:gate"]')!;
    assert.equal(first.querySelector("[data-canvas-writing-delivery]")!.textContent, "Keywords: city gate、guard");
    assert.equal(container.querySelector('[data-canvas-writing-object="entry:tone"] [data-canvas-writing-delivery]')!.textContent, "Sent every turn");
    await update({ compact: true });
    assert.equal(container.querySelector("[data-canvas-writing-delivery]"), null, "simple mode is the names alone");
    assert.equal(container.querySelector("[data-canvas-writing-preview]"), null);
  });
});

test("an empty block invites the first entry rather than pretending to be one", async () => {
  await withNode({ kind: "setting", entries: [] }, async ({ container, click, adds }) => {
    assert.equal(container.querySelector("textarea"), null);
    const row = container.querySelector("[data-canvas-writing-empty]")!;
    assert.ok(row, "the block still shows the shape of the thing it holds");
    await click(row.querySelector("[data-canvas-writing-open]")!);
    assert.equal(adds(), 1, "clicking the invitation makes the entry");
  });
});

test("an unwritten row is its name and a not-written mark; a written one shows what it says", async () => {
  const written = entry("history", { content: "The city was built on a river bend." });
  const blank = entry("systems", { content: "" });
  await withNode({ kind: "setting", entries: [written, blank] }, async ({ container, data }) => {
    const first = container.querySelector('[data-canvas-writing-object="entry:history"]')!;
    const second = container.querySelector('[data-canvas-writing-object="entry:systems"]')!;
    assert.match(first.querySelector("[data-canvas-writing-preview]")!.textContent!, /The city was built/);
    // The template's guidance waits until the row is opened.
    assert.equal(second.querySelector("[data-canvas-writing-preview]"), null);
    assert.equal(second.querySelector("[data-canvas-writing-unwritten]"), null, "an unwritten row is its name alone");
    assert.equal(canvasWritingNodeHeight(data()), 40 + 2 + 96 + 40);
  });
});

test("rows keep their graph handles, hover and canonical object IDs, and inspection disables connecting", async () => {
  const setting = entry("mine:history", { alwaysSend: false, keywords: ["mine"] });
  await withNode({ kind: "setting", entries: [setting, entry("town")], rows: [{ g: { id: "entry:mine:history", kind: "entry", title: setting.name, ports: [], data: {} }, title: setting.name, hasIn: true, hasOut: true, slots: [{ portId: "legacy-slot", label: "Existing slot" }] }] }, async ({ container, data, toggled, hovered, click, update }) => {
    const section = container.querySelector('[data-canvas-writing-object="entry:mine:history"]')!;
    // A row that does not simply always send says so, in the space a row has:
    // in words in detail, and as the one dot a name-only row has room for.
    assert.equal(section.querySelector("[data-canvas-writing-delivery]")!.textContent, "Keywords: mine");
    assert.equal(section.querySelector('[aria-label="Custom activation"]'), null, "and not both at once");
    await update({ compact: true });
    assert.equal(container.querySelector('[data-canvas-writing-object="entry:mine:history"] [aria-label="Custom activation"]')?.getAttribute("title"), "Custom activation");
    await update({ compact: false });
    // A slot adds its own height to the row, and the layout has to agree.
    assert.equal(canvasWritingNodeHeight(data()), 40 + 2 + (96 + 24) + 96);
    await act(async () => {
      section.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
      section.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, relatedTarget: container }));
    });
    assert.deepEqual(hovered, ["entry:mine:history", null], "hover exposes and clears this object's actual graph connections");
    for (const id of [rowHandleId("entry:mine:history", "in"), rowHandleId("entry:mine:history", "out"), portHandleId("entry:mine:history", "legacy-slot")]) {
      const handle = [...section.querySelectorAll(".react-flow__handle")].find(element => element.getAttribute("data-handleid") === id);
      assert.ok(handle, `actual ReactFlow handle ${id} remains available`);
      assert.equal(handle.getAttribute("data-nodeid"), "writing-node");
    }
    await click(section.querySelector('[data-canvas-writing-expand="entry:mine:history"]')!);
    assert.deepEqual(toggled, ["entry:mine:history"]);
    await update({ readOnly: true });
    assert.equal(section.querySelectorAll(".react-flow__handle.connectable").length, 0, "inspection does not enable connection mutations");
  });
});

function objectTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    effectAllowed: "none", dropEffect: "none",
    get types() { return [...values.keys()]; },
    setData: (type: string, value: string) => { values.set(type, value); },
    getData: (type: string) => values.get(type) ?? "",
    setDragImage: () => {},
  } as unknown as DataTransfer;
}
async function dragEvent(element: Element, type: string, transfer: DataTransfer) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  await act(async () => element.dispatchEvent(event));
  return event;
}

test("rows retain shared ownership, context actions and drag ordering", async () => {
  const shared = entry("shared", { content: "Shared prose" });
  const own = entry("own", { worldbookId: "mine" });
  const rows = [shared, own].map(item => ({ g: { id: `entry:${item.id}`, kind: "entry" as const, title: item.name, ports: [], data: {}, ...(item.worldbookId ? { parentId: `module:${item.worldbookId}` } : {}) }, title: item.name, hasIn: false, hasOut: true, slots: [], shared: !item.worldbookId }));
  await withNode({ kind: "setting", entries: [shared, own], rows, ownerId: "mine", width: 300 }, async ({ container, menus, drops, update }) => {
    const first = container.querySelector('[data-canvas-writing-object="entry:shared"]')!;
    const second = container.querySelector('[data-canvas-writing-object="entry:own"]')!;
    const mark = first.querySelector("[data-canvas-writing-shared]")!;
    assert.equal(mark.getAttribute("aria-label"), "shared");
    assert.equal(mark.getAttribute("title"), "One object shared with every module");
    assert.equal(second.querySelector("[data-canvas-writing-shared]"), null);
    await act(async () => first.querySelector("[data-canvas-writing-more]")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 80, clientY: 45 })));
    assert.deepEqual(menus, [{ id: "entry:shared", x: 80, y: 45 }]);

    const sharedTransfer = objectTransfer();
    const grip = first.querySelector("[data-canvas-writing-drag]")!;
    await dragEvent(grip, "dragstart", sharedTransfer);
    assert.equal(sharedTransfer.getData("application/yumina-object"), "entry:shared");
    assert.ok(sharedTransfer.types.includes("application/yumina-from-core"), "a shared row's actual owner remains the card");
    assert.ok(sharedTransfer.types.includes("application/yumina-view-mine"));
    await dragEvent(second, "dragover", sharedTransfer);
    const dropped = await dragEvent(second, "drop", sharedTransfer);
    assert.equal(dropped.defaultPrevented, true);
    assert.deepEqual(drops, [["entry:shared", "entry:own"]]);
    await dragEvent(grip, "dragend", sharedTransfer);

    const ownTransfer = objectTransfer();
    await dragEvent(second.querySelector("[data-canvas-writing-drag]")!, "dragstart", ownTransfer);
    assert.ok(ownTransfer.types.includes("application/yumina-from-mine"));
    await update({ readOnly: true });
    assert.equal(container.querySelector("[data-canvas-writing-drag]"), null);
    assert.equal(container.querySelector("[data-canvas-writing-more]"), null);
    await dragEvent(second, "drop", sharedTransfer);
    assert.equal(drops.length, 1, "inspection cannot reorder or move content");
  });
});

test("loose sharing uses existing header space, and simple mode is the names alone", async () => {
  let shares = 0;
  const entries = Array.from({ length: 8 }, (_, index) => entry(`setting-${index}`));
  await withNode({ kind: "setting", entries, loose: { onShareAll: () => { shares++; } } }, async ({ container, data, click, update }) => {
    assert.equal(canvasWritingNodeHeight(data()), 40 + 2 + 8 * 96);
    assert.ok(container.querySelector("article > header [data-loose-banner]"));
    await click(container.querySelector("[data-canvas-writing-share-all]")!);
    assert.equal(shares, 1);
    assert.equal(canvasWritingNodeHeight(data()), 40 + 2 + 8 * 96, "the loose header adds no unmeasured banner height");
    await update({ compact: true });
    assert.equal(canvasWritingNodeHeight(data()), 40 + 2 + 8 * 40);
    const first = container.querySelector('[data-canvas-writing-object="entry:setting-0"]')!;
    assert.equal((first as HTMLElement).style.height, "40px");
    assert.equal(first.querySelector("[data-canvas-writing-preview]"), null, "simple rows are names, with no line under them");
    assert.equal(first.querySelector("[data-canvas-writing-open]")!.textContent, "setting-0");
    await update({ readOnly: true });
    assert.equal(container.querySelector("[data-canvas-writing-share-all]"), null);
    assert.ok(container.querySelector("[data-loose-banner]"), "ownership information remains visible during inspection");
  });
});

test("an entry the interface decides says so on the canvas, as the inspector does", async () => {
  // The row reads the same card context the inspector reads. Without the
  // bindings it called a frontend-bound entry "not set" and put a warning on
  // it while the inspector beside it said the interface was in charge.
  const { useEditorStore } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("@/stores/editor");
  const draft = useEditorStore.getState().worldDraft;
  useEditorStore.setState({ worldDraft: { ...draft, loreUiBindings: [{ slotId: "panel", entryId: "shown", conditions: [], conditionLogic: "all" }] } });
  try {
    const bound = entry("shown", { alwaysSend: false });
    await withNode({ kind: "setting", entries: [bound] }, async ({ container }) => {
      const row = container.querySelector('[data-canvas-writing-object="entry:shown"]')!;
      assert.equal(row.querySelector("[data-canvas-writing-delivery]")!.textContent, "Interface decides");
    });
  } finally {
    useEditorStore.setState({ worldDraft: draft });
  }
});

test("a folder counts and selects all its members whether it is open or shut", async () => {
  const selections: string[][] = [];
  const presets = Array.from({ length: 5 }, (_, index) => entry(`preset-${index}`, { presetId: `official-${index}` }));
  const entries = [entry("own"), ...presets];
  await withNode({ kind: "setting", entries, presetsTitle: "Defaults", onSelectFolder: ids => { selections.push(ids); } }, async ({ container, click, update }) => {
    const count = () => container.querySelector('[data-canvas-writing-folder="__presets"] button[aria-pressed] .tabular-nums')!.textContent;
    assert.equal(count(), "5");
    await update({ collapsedFolders: new Set(["__presets"]) });
    assert.ok(container.querySelector('[data-canvas-writing-folder-shut]'));
    assert.equal(container.querySelector('[data-canvas-writing-object="entry:preset-0"]'), null, "a shut folder draws no rows");
    assert.equal(count(), "5", "shutting a folder does not change what it holds");
    await click(container.querySelector('[data-canvas-writing-folder="__presets"] button[aria-pressed]')!);
    assert.equal(selections.at(-1)?.length, 5, "the shut header still selects every member");
  });
});

test("two columns share their lines: a short unwritten row beside a written one is counted at the written height", async () => {
  // Dealt by column: 世界观 (unwritten), 站规, 周礼 on the left; 叙事, 新词条 on the right.
  const entries = [entry("a", { content: "" }), entry("b"), entry("c"), entry("d"), entry("e")];
  await withNode({ kind: "setting", entries, columns: 2 }, async ({ data }) => {
    assert.equal(canvasWritingNodeHeight(data()), 40 + 2 + 3 * 96, "three full lines, not 40 + 96 + 96 on the left");
  });
});
