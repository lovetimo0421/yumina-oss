import test, { after } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { JSDOM } from "jsdom";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { UiElement, UiPage, Variable } from "@yumina/engine";
import type { ActionContext } from "../element-behavior";
import { idsToNames, namesToIds } from "./variable-text";
import { moveItem, parseTags } from "./choice-editor";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: "http://localhost" });
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const { ChoiceEditor } = await import("./choice-editor");
const { FieldEditor } = await import("./field-editor");
const { PopupEditor } = await import("./popup-editor");
const { ListEditor } = await import("./list-editor");
const { RequiresEditor } = await import("./requires-editor");
const { LookPicker } = await import("./look-picker");
const { applyUiLook, currentUiLook } = await import("@yumina/engine");
const { MakeVariableContext } = await import("./part-kit");
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const i18n = createInstance();
await i18n.use(initReactI18next).init({ lng: "en", resources: { en: { editor: {} } }, interpolation: { escapeValue: false } });

const variables: Variable[] = [
  { id: "v-name", name: "Name", type: "string", defaultValue: "" },
  { id: "v-team", name: "Team", type: "json", defaultValue: [] },
  { id: "v-age", name: "Age", type: "number", defaultValue: 0 },
];
/** Variables the editors made, standing in for the editor store. */
const made: Variable[] = [];
const makeVariable = (base: string, type: Variable["type"], defaultValue: Variable["defaultValue"]) => {
  const v = { id: `new-${made.length + 1}`, name: base, type, defaultValue } as Variable;
  made.push(v);
  return { id: v.id, name: v.name };
};
const madeVar = (id: string | undefined) => made.find((v) => v.id === id);

const pages: UiPage[] = [{ id: "p1", name: "Main", height: 812, elements: [] }];
const ctx: ActionContext = { variables, pages, pageId: "p1", greetings: [{ index: 0, label: "1 · Dawn" }, { index: 1, label: "2 · Dusk" }], tracks: [] };

/** Mounts an editor over a live element, so each edit re-renders with the
 *  element it produced — the way the panel drives it. */
async function mountEditor<T extends UiElement>(initial: T, render: (el: T, onPatch: (fn: (el: T) => T) => void) => ReturnType<typeof createElement>) {
  let latest = initial;
  function Host() {
    const [el, setEl] = useState(initial);
    return render(el, (fn) => setEl((cur) => { latest = fn(cur); return latest; }));
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement(MakeVariableContext.Provider, { value: makeVariable }, createElement(Host)))));
  return { host, latest: () => latest, unmount: () => act(async () => root.unmount()) };
}

async function change(el: Element, value: string) {
  await act(async () => {
    const proto = el.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype
      : el.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
const click = (el: Element | null | undefined) => act(async () => {
  assert.ok(el, "element to click");
  el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
});
const byLabel = (host: Element, label: string) => host.querySelector(`[aria-label="${label}"]`);

test("texts show variable names and store ids, exactly both ways", () => {
  const vars = [{ id: "3f2a", name: "好感" }, { id: "b1", name: "Dup" }, { id: "b2", name: "Dup" }];
  assert.equal(idsToNames("你对我的好感是 {{3f2a}}", vars), "你对我的好感是 {{好感}}");
  assert.equal(namesToIds("你对我的好感是 {{好感}}", vars), "你对我的好感是 {{3f2a}}");
  // A name two variables share cannot be mapped back, so it is left as the id.
  assert.equal(idsToNames("{{b1}}", vars), "{{b1}}");
  assert.equal(namesToIds("{{Dup}}", vars), "{{Dup}}");
  // Scope tokens and unknown names pass through.
  assert.equal(namesToIds("{{item.title}} {{value}} {{choice}}", vars), "{{item.title}} {{value}} {{choice}}");
  const typed = "a {{好感}} b {{unknown}}";
  assert.equal(idsToNames(namesToIds(typed, vars), vars), typed);
});

test("small list helpers", () => {
  assert.deepEqual(moveItem([1, 2, 3], 0, 1), [2, 1, 3]);
  assert.deepEqual(moveItem([1, 2, 3], 0, -1), [1, 2, 3]);
  assert.deepEqual(parseTags("温柔, 校园，日常、 "), ["温柔", "校园", "日常"]);
});

test("the choice editor lays out, counts, and edits its option table", async () => {
  const el: Extract<UiElement, { type: "choice" }> = {
    id: "c", type: "choice", x: 0, y: 0, w: 339, h: 300, layout: "grid", columns: 2, variableId: "v-name",
    options: [{ id: "a", title: "Dawn" }, { id: "b", title: "Dusk" }],
  };
  const m = await mountEditor(el, (cur, onPatch) => createElement(ChoiceEditor, { el: cur, onPatch, variables, ctx }));
  // Layout: the full-width swipe.
  await click([...m.host.querySelectorAll('[role="radio"]')].find((b) => b.textContent === "studio.parts.choice.layoutCarousel"));
  assert.equal(m.latest().layout, "carousel");
  // Rename, add, reorder and remove options.
  await change(m.host.querySelectorAll('[aria-label="studio.parts.choice.title"]')[1]!, "Dusk road");
  assert.equal(m.latest().options[1]!.title, "Dusk road");
  await click([...m.host.querySelectorAll("button")].find((b) => b.textContent?.includes("studio.parts.choice.addOption")));
  assert.equal(m.latest().options.length, 3);
  await click(m.host.querySelectorAll('[aria-label="studio.parts.moveUp"]')[1]);
  assert.deepEqual(m.latest().options.map((o) => o.title), ["Dusk road", "Dawn", "studio.parts.choice.newOption"]);
  await click(m.host.querySelectorAll('[aria-label="studio.parts.remove"]')[0]);
  assert.deepEqual(m.latest().options.map((o) => o.title), ["Dawn", "studio.parts.choice.newOption"]);
  // The new option opened for editing: its step list can switch the opening.
  const addStep = [...m.host.querySelectorAll("button")].find((b) => b.textContent?.includes("studio.element.addStep"));
  await click(addStep);
  await change(m.host.querySelector('[aria-label="studio.element.stepKind"]')!, "switch-greeting");
  assert.deepEqual(m.latest().options[1]!.actions, [{ kind: "switch-greeting", index: 0 }]);
  // Several picks switch the variable to a list one.
  await click([...m.host.querySelectorAll('[role="radio"]')].find((b) => b.textContent === "studio.parts.choice.pickMany"));
  assert.equal(m.latest().multi, true);
  // Confirm on: the button text is kept in the document.
  await click(byLabel(m.host, "studio.parts.choice.confirm"));
  assert.equal(m.latest().confirm?.label.template, "studio.parts.choice.confirmDefault");
  await m.unmount();
});

test("switching a pick to several brings a list variable with it", async () => {
  const el: Extract<UiElement, { type: "choice" }> = { id: "c", type: "choice", x: 0, y: 0, w: 1, h: 1, layout: "grid", variableId: "v-name", options: [] };
  const m = await mountEditor(el, (cur, onPatch) => createElement(ChoiceEditor, { el: cur, onPatch, variables, ctx }));
  await click([...m.host.querySelectorAll('[role="radio"]')].find((b) => b.textContent === "studio.parts.choice.pickMany"));
  assert.equal(madeVar(m.latest().variableId)?.type, "json");
  await m.unmount();
});

test("the field editor switches kind, writes chip options and bounds", async () => {
  const el: Extract<UiElement, { type: "field" }> = { id: "f", type: "field", x: 0, y: 0, w: 300, h: 74, kind: "text", variableId: "v-name", label: { template: "Hi {{v-name}}" } };
  const m = await mountEditor(el, (cur, onPatch) => createElement(FieldEditor, { el: cur, onPatch, variables }));
  // The question box shows the variable's name, not its id.
  assert.equal((byLabel(m.host, "studio.parts.field.label") as HTMLInputElement).value, "Hi {{Name}}");
  await change(byLabel(m.host, "studio.parts.field.label")!, "Hello {{Name}}");
  assert.equal(m.latest().label?.template, "Hello {{v-name}}");
  await change(byLabel(m.host, "studio.parts.field.kind")!, "chips");
  assert.equal(m.latest().kind, "chips");
  assert.ok(m.latest().options!.length > 0);
  await change(byLabel(m.host, "studio.parts.field.options")!, "Knight\n\nMage\n");
  assert.deepEqual(m.latest().options, ["Knight", "Mage"]);
  await click(byLabel(m.host, "studio.parts.field.allowCustom"));
  assert.equal(m.latest().allowCustom, true);
  // A slider writes a number variable, so a fresh one comes with it.
  await change(byLabel(m.host, "studio.parts.field.kind")!, "slider");
  assert.equal(m.latest().kind, "slider");
  assert.deepEqual([m.latest().min, m.latest().max], [0, 100]);
  assert.equal(madeVar(m.latest().variableId)?.type, "number");
  await m.unmount();
});

test("the popup editor inserts the variable's value and toggles clearing", async () => {
  const el: Extract<UiElement, { type: "popup" }> = { id: "p", type: "popup", x: 0, y: 0, w: 300, h: 300, variableId: "v-name", body: { template: "" } };
  const m = await mountEditor(el, (cur, onPatch) => createElement(PopupEditor, { el: cur, onPatch, variables }));
  const inserts = m.host.querySelectorAll('[aria-label="studio.parts.insert"]');
  await change(inserts[1]!, "value");
  assert.equal(m.latest().body.template, "{{value}}");
  await change(inserts[1]!, "v-age");
  assert.equal(m.latest().body.template, "{{value}}{{v-age}}");
  // The popup's own token reads as words in the box (the label is the i18n
  // key here), while the document keeps `{{value}}`.
  assert.equal((byLabel(m.host, "studio.parts.popup.body") as HTMLTextAreaElement).value, "{{studio.parts.popup.theValue}}{{Age}}");
  await click(byLabel(m.host, "studio.parts.popup.clearOnClose"));
  assert.equal(m.latest().clearOnClose, false);
  await click(byLabel(m.host, "studio.parts.popup.clearOnClose"));
  assert.equal("clearOnClose" in m.latest(), false);
  await m.unmount();
});

test("a list can show the card's characters or one of its folders, and make a character on the spot", async () => {
  const el: Extract<UiElement, { type: "list" }> = {
    id: "l", type: "list", x: 0, y: 0, w: 300, h: 300, source: { kind: "static", items: [] }, item: { template: "{{item}}" },
  };
  const characters: string[] = [];
  const withEntries: ActionContext = {
    ...ctx,
    entrySources: [
      { key: "role:character", source: { role: "character" }, label: "Characters · 3" },
      { key: "folder:f1", source: { folderId: "f1" }, label: "Folder Places · 5" },
    ],
    newCharacter: (name) => { characters.push(name); },
  };
  const m = await mountEditor(el, (cur, onPatch) => createElement(ListEditor, { el: cur, onPatch, variables, ctx: withEntries }));
  await click([...m.host.querySelectorAll('[role="radio"]')].find((b) => b.textContent === "studio.parts.list.sourceEntries"));
  assert.deepEqual(m.latest().source, { kind: "entries", role: "character" });
  assert.equal(m.latest().item.template, "{{item.title}}");
  // Name and portrait; the text written for the AI stays off unless asked for.
  assert.deepEqual(m.latest().card, { title: { template: "{{item.title}}" }, imageField: "image" });
  await change(m.host.querySelector('[data-list-entries] select')!, "folder:f1");
  assert.deepEqual(m.latest().source, { kind: "entries", folderId: "f1" });
  await change(m.host.querySelector('[data-list-entries] select')!, "role:character");
  await click([...m.host.querySelectorAll("button")].find((b) => b.textContent === "studio.parts.list.newCharacter"));
  await change(m.host.querySelector('[data-list-entries] input')!, "Shen Fei");
  await click([...m.host.querySelectorAll("button")].find((b) => b.textContent === "studio.element.newVariableCreate"));
  assert.deepEqual(characters, ["Shen Fei"]);
  await m.unmount();
});

test("the list editor keeps authored rows as records and turns on cards, locks and row steps", async () => {
  const el: Extract<UiElement, { type: "list" }> = {
    id: "l", type: "list", x: 0, y: 0, w: 300, h: 300, source: { kind: "static", items: ["Ring", "Map"] }, item: { template: "{{item}}" },
  };
  const m = await mountEditor(el, (cur, onPatch) => createElement(ListEditor, { el: cur, onPatch, variables, ctx }));
  await change(m.host.querySelectorAll('[aria-label="studio.parts.list.rowBody"]')[0]!, "Found at the well");
  const src = m.latest().source;
  assert.equal(src.kind, "static");
  assert.deepEqual(src.kind === "static" && src.items, [{ title: "Ring", body: "Found at the well" }, { title: "Map" }]);
  assert.equal(m.latest().item.template, "{{item.title}}");
  await click(byLabel(m.host, "studio.parts.list.cardOn"));
  assert.deepEqual(m.latest().card?.title, { template: "{{item.title}}" });
  assert.equal(m.latest().card?.imageField, "image");
  await click([...m.host.querySelectorAll('[role="radio"]')].find((b) => b.textContent === "studio.parts.list.shape_square"));
  assert.equal(m.latest().card?.imageRatio, 1);
  assert.equal(m.latest().direction, "row");
  await click(byLabel(m.host, "studio.parts.list.lockOn"));
  assert.equal(m.latest().card?.lockedUnless?.variableId, "v-team");
  assert.equal(m.latest().card?.lockedUnless?.field, "title");
  // The locked text reads names and stores ids, like every other card text.
  const locked = byLabel(m.host, "studio.parts.list.lockedText") as HTMLInputElement;
  await change(locked, "{{Name}} ???");
  assert.deepEqual(m.latest().card?.lockedText, { template: "{{v-name}} ???" });
  assert.equal((byLabel(m.host, "studio.parts.list.lockedText") as HTMLInputElement).value, "{{Name}} ???");
  const addStep = [...m.host.querySelectorAll("button")].find((b) => b.textContent?.includes("studio.element.addStep"));
  await click(addStep);
  assert.equal(m.latest().rowActions?.length, 1);
  await m.unmount();
});

test("a button's 这些填好了才能按 ticks variables on and off", async () => {
  let value: string[] = ["gone-id"];
  function Host() {
    const [v, setV] = useState(value);
    return createElement(RequiresEditor, { value: v, variables, onChange: (next: string[]) => { value = next; setV(next); } });
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(Host))));
  const boxes = host.querySelectorAll('input[type="checkbox"]');
  // Three variables plus the deleted one still ticked, so it can be unticked.
  assert.equal(boxes.length, 4);
  await click(boxes[0]!);
  assert.deepEqual(value, ["gone-id", "v-name"]);
  await click(boxes[3]!);
  assert.deepEqual(value, ["v-name"]);
  await act(async () => root.unmount());
});

test("换个样子: one click restyles the part, marks the look, and keeps its cards", async () => {
  const el: Extract<UiElement, { type: "choice" }> = {
    id: "c", type: "choice", x: 0, y: 0, w: 339, h: 300, layout: "grid", columns: 2, variableId: "v-name",
    options: [{ id: "a", title: "Dawn" }, { id: "b", title: "Dusk" }],
  };
  const m = await mountEditor(el, (cur, onPatch) =>
    createElement(LookPicker, { el: cur, tokens: { "--yc-send-bg": "#4c7dbf" }, onApply: (id: string) => onPatch((e) => applyUiLook(e, id)) }));
  const looks = m.host.querySelectorAll('[role="radio"]');
  assert.ok(looks.length >= 5, "the theme default and at least four looks");
  // Nothing applied yet: the theme default is the one ticked.
  assert.equal(m.host.querySelector('[aria-checked="true"]')?.getAttribute("data-testid"), "look-choice-default");
  await click(m.host.querySelector('[data-testid="look-choice-bookmark"]'));
  assert.equal(currentUiLook(m.latest()), "choice-bookmark");
  assert.ok(m.latest().style?.card?.fills?.length, "the look wrote style fields");
  assert.deepEqual(m.latest().options.map((o) => o.title), ["Dawn", "Dusk"]);
  assert.equal(m.host.querySelector('[aria-checked="true"]')?.getAttribute("data-testid"), "look-choice-bookmark");
  // Back to the theme: no style, no look block.
  await click(m.host.querySelector('[data-testid="look-choice-default"]'));
  assert.equal(m.latest().style, undefined);
  assert.equal(m.latest().css, undefined);
  await m.unmount();
});

test("换个样子 is not offered for a plain text list", async () => {
  const el: Extract<UiElement, { type: "list" }> = {
    id: "l", type: "list", x: 0, y: 0, w: 200, h: 200, source: { kind: "static", items: ["a"] }, item: { template: "{{item}}" },
  };
  const m = await mountEditor(el, (cur) => createElement(LookPicker, { el: cur, tokens: undefined, onApply: () => {} }));
  assert.equal(m.host.querySelector('[data-testid="look-picker"]'), null);
  await m.unmount();
});
