import test, { after } from "node:test";
import assert from "node:assert/strict";
import { act, createContext, createElement, useContext, useState, type ComponentType } from "react";
import { JSDOM } from "jsdom";
import { compileUiDoc, type UiDoc, type UiElement } from "@yumina/engine";
import { bundleAndCompile } from "@/lib/tsx/tsx-bundler";

/**
 * The four form parts, compiled from a document and run through the real
 * bundler, then clicked and typed into the way a player would.
 */

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: "http://localhost" });
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
  CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

type Vars = Record<string, unknown>;
interface Harness {
  host: HTMLElement;
  vars: () => Vars;
  log: string[];
  /** Write a variable from outside, the way the AI's reply would. */
  set: (id: string, value: unknown) => Promise<void>;
  unmount: () => Promise<void>;
}

const ApiContext = createContext<unknown>(null);

async function mount(elements: UiElement[], initial: Vars, extra: Record<string, unknown> = {}): Promise<Harness> {
  const doc: UiDoc = { version: 1, entryPageId: "p1", pages: [{ id: "p1", name: "Main", height: 812, elements }] };
  const built = bundleAndCompile(compileUiDoc(doc), () => useContext(ApiContext));
  assert.equal(built.error, null, String(built.error));
  const Card = built.Component as ComponentType;
  const log: string[] = [];
  let current: Vars = { ...initial };
  let setOuter: (v: Vars) => void = () => {};
  function Shell() {
    const [vars, setVars] = useState<Vars>(current);
    setOuter = (v) => { current = v; setVars(v); };
    const api = {
      variables: vars,
      messages: [],
      setVariable: (id: string, value: unknown) => {
        log.push(`set ${id}=${JSON.stringify(value)}`);
        setOuter({ ...current, [id]: value });
      },
      resolveAssetUrl: (ref: string) => `https://cdn.test/${ref.replace("@asset:", "")}`,
      showToast: (text: string) => { log.push(`toast ${text}`); },
      ...extra,
    };
    return createElement(ApiContext.Provider, { value: api }, createElement(Card));
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Shell)));
  return {
    host, vars: () => current, log,
    set: (id, value) => act(async () => setOuter({ ...current, [id]: value })),
    unmount: () => act(async () => root.unmount()),
  };
}

const box = { x: 18, y: 100, w: 339, h: 300 };
const click = (el: Element | null) => act(async () => {
  assert.ok(el, "element to click");
  el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
});
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

async function typeInto(el: Element, value: string) {
  await act(async () => {
    const proto = el.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("a card pick writes its variable, runs its steps in order and waits for the opening switch", async () => {
  let release!: () => void;
  const h = await mount([{
    id: "c", type: "choice", ...box, layout: "grid", columns: 2, variableId: "opening",
    options: ["Dawn", "Dusk", "Storm", "Tide"].map((title, i) => ({
      id: `o${i}`, title, subtitle: `Opening ${i + 1}`, value: title.toLowerCase(),
      actions: [
        { kind: "switch-greeting" as const, index: i },
        { kind: "toast" as const, text: { template: "picked {{choice}}" } },
      ],
    })),
  }], { opening: "" }, {
    switchGreeting: (i: number) => new Promise<void>((resolve) => { h.log.push(`switch ${i}`); release = () => { h.log.push("switched"); resolve(); }; }),
  });
  const cards = h.host.querySelectorAll("button.yp-card");
  assert.equal(cards.length, 4);
  assert.match(h.host.innerHTML, /Dusk/);
  assert.match(h.host.innerHTML, /yp-tile/, "a card without a picture gets a tinted, patterned tile, not a grey box");
  assert.match(h.host.innerHTML, /yp-glyph/, "…with its first character on it");
  await click(cards[1]!);
  assert.equal(cards[1]!.getAttribute("aria-pressed"), "true");
  assert.deepEqual(h.log, ['set opening="dusk"', "switch 1"]);
  release();
  await wait(5);
  // After the switch: the toast reads {{choice}}, and the pick is written again
  // over whatever the opening restored.
  assert.deepEqual(h.log, ['set opening="dusk"', "switch 1", "switched", "toast picked dusk", 'set opening="dusk"']);
  await h.unmount();
});

test("cards per row hold on the wide canvas too; unset fits the box there and is two on the phone", async () => {
  const w = window as unknown as Record<string, unknown>;
  const grid = (h: Harness) => (h.host.querySelector(".yp-grid") as HTMLElement).style.gridTemplateColumns;
  const part = (columns?: number): UiElement => ({
    id: "c", type: "choice", ...box, desktop: { x: 40, y: 40, w: 900, h: 400 }, layout: "grid",
    ...(columns ? { columns } : {}), variableId: "opening",
    options: ["Dawn", "Dusk", "Storm", "Tide"].map((title, i) => ({ id: `o${i}`, title })),
  });
  // The stage picks its canvas in a measured layout effect; give it a box to
  // measure and let the editor flag name the canvas.
  const g = globalThis as unknown as Record<string, unknown>;
  const hadObserver = "ResizeObserver" in g;
  const priorObserver = g.ResizeObserver;
  const proto = dom.window.HTMLElement.prototype;
  const priorRect = proto.getBoundingClientRect;
  g.ResizeObserver = class { observe() {} disconnect() {} };
  proto.getBoundingClientRect = () => ({ width: 1440, height: 900, top: 0, left: 0, right: 1440, bottom: 900, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const on = async (canvas: "phone" | "desktop", columns?: number) => {
    w.__yuminaUiEditing = true;
    w.__yuminaUiEditCanvas = canvas;
    const h = await mount([part(columns)], { opening: "" });
    const cols = grid(h);
    await h.unmount();
    return cols;
  };
  try {
    assert.equal(await on("desktop", 3), "repeat(3, minmax(0, 1fr))", "a set count is not widened on the desktop");
    assert.equal(await on("phone", 3), "repeat(3, minmax(0, 1fr))");
    assert.equal(await on("desktop"), "repeat(4, minmax(0, 1fr))", "unset: as many as fit, never more than there are");
    assert.equal(await on("phone"), "repeat(2, minmax(0, 1fr))");
  } finally {
    delete w.__yuminaUiEditing;
    delete w.__yuminaUiEditCanvas;
    proto.getBoundingClientRect = priorRect;
    if (hadObserver) g.ResizeObserver = priorObserver;
    else delete g.ResizeObserver;
  }
});

test("multi pick writes a json array, honours the cap, and only the confirm button runs steps", async () => {
  const h = await mount([{
    id: "c", type: "choice", ...box, layout: "list", multi: true, maxPick: 2, variableId: "team",
    confirm: { label: { template: "Go with {{team}}" }, actions: [{ kind: "toast", text: { template: "team: {{choice}}" } }] },
    options: ["A", "B", "C"].map((title, i) => ({ id: `o${i}`, title, actions: [{ kind: "toast" as const, text: { template: "{{choice}} joins" } }] })),
  }], { team: [] });
  const confirm = () => h.host.querySelector("button.yp-confirm") as HTMLButtonElement;
  assert.equal(confirm().disabled, true);
  const cards = () => h.host.querySelectorAll("button.yp-card");
  await click(cards()[0]!);
  await click(cards()[2]!);
  await click(cards()[1]!); // over the cap: ignored
  assert.deepEqual(h.vars().team, ["A", "C"]);
  assert.equal(cards()[1]!.getAttribute("aria-disabled"), "true");
  assert.ok(!h.log.some((l) => l.startsWith("toast")), "picking alone runs nothing");
  assert.equal(confirm().disabled, false);
  await click(confirm());
  await wait(5);
  assert.deepEqual(h.log.filter((l) => l.startsWith("toast")), ["toast A joins", "toast C joins", "toast team: A, C"]);
  // Un-picking frees a slot.
  await click(cards()[0]!);
  assert.deepEqual(h.vars().team, ["C"]);
  await h.unmount();
});

test("the carousel moves with its arrows, dots and keyboard, and tapping picks", async () => {
  const h = await mount([{
    id: "c", type: "choice", ...box, layout: "carousel", variableId: "route",
    options: ["One", "Two", "Three"].map((title, i) => ({ id: `o${i}`, title, detail: `${title} detail`, image: { kind: "asset" as const, ref: `@asset:img${i}` } })),
  }], { route: "" });
  const track = () => h.host.querySelector(".yp-track") as HTMLElement;
  const next = h.host.querySelector(".yp-next")!;
  const prev = h.host.querySelector(".yp-prev") as HTMLButtonElement;
  assert.equal(prev.disabled, true);
  await click(next);
  assert.match(track().style.transform, /-100%/);
  await click(h.host.querySelectorAll(".yp-dot")[2]!);
  assert.match(track().style.transform, /-200%/);
  await act(async () => {
    h.host.querySelector(".yp-car")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  });
  assert.match(track().style.transform, /-100%/);
  assert.match(h.host.innerHTML, /https:\/\/cdn\.test\/img1/);
  await click(h.host.querySelectorAll("button.yp-card")[1]!);
  assert.equal(h.vars().route, "Two");
  await h.unmount();
});

test("a field writes as the player types, and a button waiting on it wakes up", async () => {
  const h = await mount([
    { id: "f", type: "field", x: 20, y: 100, w: 300, h: 74, kind: "text", variableId: "name", label: { template: "Your name" }, placeholder: "e.g. Rin" },
    { id: "b", type: "button", x: 20, y: 200, w: 200, h: 44, label: { template: "Start" }, actions: [{ kind: "toast", text: { template: "hi {{name}}" } }], requires: ["name"] },
  ], { name: "" });
  const input = h.host.querySelector("input.yp-input") as HTMLInputElement;
  const label = h.host.querySelector("label.yp-label")!;
  assert.equal(label.getAttribute("for"), input.id, "the label names its input");
  assert.equal(input.placeholder, "e.g. Rin");
  const start = () => h.host.querySelector('[data-ui-el="b"]') as HTMLButtonElement;
  assert.equal(start().disabled, true);
  await typeInto(input, "R");
  // The first character lands at once …
  assert.equal(h.vars().name, "R");
  assert.equal(start().disabled, false);
  await typeInto(input, "Rin");
  // … the rest after the pause.
  assert.equal(h.vars().name, "R");
  await wait(350);
  assert.equal(h.vars().name, "Rin");
  await click(start());
  await wait(5);
  assert.ok(h.log.includes("toast hi Rin"));
  await h.unmount();
});

test("chips, a number and a slider write the value type the variable holds", async () => {
  const h = await mount([
    { id: "chips", type: "field", x: 0, y: 0, w: 300, h: 80, kind: "chips", variableId: "cls", options: ["Knight", "Mage"], allowCustom: true, placeholder: "Other" },
    { id: "num", type: "field", x: 0, y: 100, w: 300, h: 80, kind: "number", variableId: "age", min: 18, max: 99, step: 1 },
    { id: "sl", type: "field", x: 0, y: 200, w: 300, h: 80, kind: "slider", variableId: "courage", min: 0, max: 10, label: { template: "Courage" } },
  ], { cls: "", age: 20, courage: 3 });
  const chips = h.host.querySelectorAll('[data-ui-el="chips"] button.yp-chip');
  assert.equal(chips.length, 3);
  await click(chips[1]!);
  assert.equal(h.vars().cls, "Mage");
  assert.equal(chips[1]!.getAttribute("aria-checked"), "true");
  const plus = h.host.querySelectorAll('[data-ui-el="num"] .yp-step')[1]!;
  await click(plus);
  assert.equal(h.vars().age, 21);
  const minus = h.host.querySelectorAll('[data-ui-el="num"] .yp-step')[0]!;
  for (let i = 0; i < 5; i++) await click(minus);
  assert.equal(h.vars().age, 18, "clamped to min");
  const range = h.host.querySelector("input.yp-range") as HTMLInputElement;
  assert.match(range.getAttribute("style") ?? "", /--yp-fill:\s*30%/);
  assert.match(h.host.querySelector('[data-ui-el="sl"] output')!.textContent ?? "", /3/);
  await h.unmount();
});

test("a popup shows while its variable holds something and clears it on close", async () => {
  const h = await mount([{
    id: "pop", type: "popup", x: 40, y: 200, w: 300, h: 260, variableId: "clue",
    title: { template: "New clue" }, body: { template: "{{value.text}} — at {{place}}" }, buttonLabel: { template: "Got it" },
  }], { clue: "", place: "the pier" });
  assert.equal(h.host.querySelector(".yp-pop"), null, "nothing shows while the variable is empty");
  await h.set("clue", { text: "A torn ticket" });
  assert.ok(h.host.querySelector(".yp-scrim"));
  assert.match(h.host.querySelector(".yp-pop-text")!.textContent ?? "", /A torn ticket — at the pier/);
  assert.equal(h.host.querySelector(".yp-pop")!.getAttribute("role"), "dialog");
  await click(h.host.querySelector(".yp-pop button.yp-confirm"));
  assert.deepEqual(h.vars().clue, {});
  assert.equal(h.host.querySelector(".yp-pop"), null);
  // A popup told to keep its variable only hides until the value changes.
  await h.unmount();
  const k = await mount([{
    id: "pop", type: "popup", x: 40, y: 200, w: 300, h: 260, variableId: "note", body: { template: "{{value}}" }, clearOnClose: false,
  }], { note: "first" });
  await click(k.host.querySelector(".yp-x"));
  assert.equal(k.vars().note, "first");
  assert.equal(k.host.querySelector(".yp-pop"), null);
  await k.set("note", "second");
  assert.match(k.host.querySelector(".yp-pop-text")!.textContent ?? "", /second/);
  await k.unmount();
});

test("a card list locks rows until a variable admits them, and a row's steps read {{item}}", async () => {
  const h = await mount([{
    id: "l", type: "list", x: 0, y: 0, w: 339, h: 400,
    source: { kind: "static", items: [
      { id: "ring", title: "Silver ring", body: "Found at the well", image: "@asset:ring" },
      { id: "map", title: "Old map", body: "Half burned", image: "@asset:map" },
    ] },
    item: { template: "{{item.title}}" },
    card: {
      title: { template: "{{item.title}}" }, subtitle: { template: "{{item.body}}" }, imageField: "image",
      lockedUnless: { variableId: "found", field: "id" }, lockedText: { template: "Not found yet" },
    },
    rowActions: [{ kind: "toast", text: { template: "look at {{item.title}}" } }],
  }], { found: ["ring"] });
  const rows = h.host.querySelectorAll(".yp-card");
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.textContent ?? "", /Silver ring/);
  assert.equal(rows[0]!.tagName, "BUTTON");
  assert.equal(rows[1]!.hasAttribute("data-locked"), true);
  assert.match(rows[1]!.textContent ?? "", /Not found yet/);
  assert.doesNotMatch(rows[1]!.textContent ?? "", /Old map|Half burned/);
  assert.equal(rows[1]!.tagName, "DIV", "a locked row cannot be pressed");
  await click(rows[0]!);
  await wait(5);
  assert.deepEqual(h.log, ["toast look at Silver ring"]);
  await h.unmount();
});
