import test, { after } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { JSDOM } from "jsdom";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { UI_CHAT_STARTED, type Condition, type UiAction, type UiPage, type Variable } from "@yumina/engine";
import {
  ActionListEditor, ConditionEditor, defaultAction, parseValueFor, showModeOf, type ActionContext,
} from "./element-behavior";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: "http://localhost" });
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
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

// Keys come back as themselves, so assertions read the key the panel asked for.
const i18n = createInstance();
await i18n.use(initReactI18next).init({ lng: "en", resources: { en: { editor: {} } }, interpolation: { escapeValue: false } });

const variables: Variable[] = [
  { id: "hp", name: "HP", type: "number", defaultValue: 10 },
  { id: "route", name: "Route", type: "string", defaultValue: "a", options: ["a", "b"] },
  { id: "met", name: "Met", type: "boolean", defaultValue: false },
];
const pages: UiPage[] = [
  { id: "p1", name: "Main", height: 812, elements: [] },
  { id: "p2", name: "Cast", height: 812, elements: [] },
];
const ctx: ActionContext = {
  variables, pages, pageId: "p1",
  greetings: [{ index: 0, label: "1 · Dawn" }, { index: 1, label: "2 · Dusk" }],
  tracks: [{ id: "bgm", name: "Theme", type: "bgm", url: "x" }],
};

async function mount(node: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, node)));
  return { host, unmount: () => act(async () => root.unmount()) };
}

async function change(el: Element, value: string) {
  await act(async () => {
    const proto = el.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype
      : el.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}

async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
}

test("a new step picks a real target, and values take the variable's type", () => {
  assert.deepEqual(defaultAction("go-page", ctx), { kind: "go-page", pageId: "p2" });
  assert.deepEqual(defaultAction("switch-greeting", ctx), { kind: "switch-greeting", index: 0 });
  assert.deepEqual(defaultAction("set-variable", ctx), { kind: "set-variable", variableId: "hp", op: "add", value: 1 });
  assert.deepEqual(defaultAction("play-audio", ctx), { kind: "play-audio", trackId: "bgm" });
  assert.equal(parseValueFor(variables[0], "7"), 7);
  assert.equal(parseValueFor(variables[2], "true"), true);
  assert.equal(parseValueFor(variables[1], "b"), "b");
});

test("a button's steps can be added, changed, reordered and removed", async () => {
  let latest: UiAction[] = [];
  function Harness() {
    const [actions, setActions] = useState<UiAction[]>([]);
    latest = actions;
    return createElement(ActionListEditor, { actions, ctx, onChange: (next: UiAction[]) => setActions(next) });
  }
  const { host, unmount } = await mount(createElement(Harness));
  try {
    const addStep = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "studio.element.addStep")!;
    await click(addStep());
    assert.deepEqual(latest, [{ kind: "send-message", text: { template: "" } }]);
    await change(host.querySelector("textarea")!, "I pick {{route}}");
    assert.deepEqual(latest, [{ kind: "send-message", text: { template: "I pick {{route}}" } }]);

    await click(addStep());
    assert.equal(latest[1]!.kind, "set-variable");
    // Second step becomes "switch the opening" and targets the second opening.
    const kinds = () => [...host.querySelectorAll('select[aria-label="studio.element.stepKind"]')];
    await change(kinds()[1]!, "switch-greeting");
    const greetingSelect = host.querySelectorAll("li")[1]!.querySelectorAll("select")[1]!;
    await change(greetingSelect, "1");
    assert.deepEqual(latest[1], { kind: "switch-greeting", index: 1 });

    // Move it to the front: the opening switch runs before the line is said.
    await click(host.querySelectorAll('button[aria-label="studio.element.moveUp"]')[1]!);
    assert.deepEqual(latest.map((a) => a.kind), ["switch-greeting", "send-message"]);

    await click(host.querySelectorAll('button[aria-label="studio.element.removeStep"]')[0]!);
    assert.deepEqual(latest.map((a) => a.kind), ["send-message"]);
  } finally {
    await unmount();
  }
});

test("a step sets off one of the card's behaviours, or a new one named on the spot", async () => {
  const made: string[] = [];
  const opened: string[] = [];
  const withBehaviors: ActionContext = {
    ...ctx,
    behaviors: [{ id: "r-close", name: "Close up", actionId: "close" }],
    newBehavior: (name) => { made.push(name); return `${name} id`; },
    openBehavior: (id) => { opened.push(id); },
  };
  assert.deepEqual(defaultAction("run-behavior", withBehaviors), { kind: "run-behavior", actionId: "close" });
  assert.deepEqual(defaultAction("run-behavior", ctx), { kind: "run-behavior", actionId: "" });
  let latest: UiAction[] = [{ kind: "run-behavior", actionId: "close" }];
  function Harness() {
    const [actions, setActions] = useState<UiAction[]>(latest);
    latest = actions;
    return createElement(ActionListEditor, { actions, ctx: withBehaviors, onChange: (next: UiAction[]) => setActions(next) });
  }
  const { host, unmount } = await mount(createElement(Harness));
  try {
    const pick = () => host.querySelector('[data-behavior-pick] select')!;
    assert.deepEqual([...pick().querySelectorAll("option")].map((o) => o.textContent), ["Close up", "studio.element.behaviorNew"]);
    await click(host.querySelector("[data-open-behavior]")!);
    assert.deepEqual(opened, ["r-close"]);

    await change(pick(), "__new__");
    const name = host.querySelector<HTMLInputElement>('[data-behavior-pick] input')!;
    await change(name, "Go upstairs");
    await click([...host.querySelectorAll("button")].find((b) => b.textContent === "studio.element.newVariableCreate")!);
    assert.deepEqual(made, ["Go upstairs"]);
    assert.deepEqual(latest, [{ kind: "run-behavior", actionId: "Go upstairs id" }]);
  } finally {
    await unmount();
  }
});

test("changing a variable offers the ways that type can change", async () => {
  let latest: UiAction[] = [{ kind: "set-variable", variableId: "hp", op: "add", value: 1 }];
  function Harness() {
    const [actions, setActions] = useState<UiAction[]>(latest);
    latest = actions;
    return createElement(ActionListEditor, { actions, ctx, onChange: (next: UiAction[]) => setActions(next) });
  }
  const { host, unmount } = await mount(createElement(Harness));
  try {
    const selects = () => host.querySelectorAll("li select");
    const opOptions = () => [...(selects()[2] as HTMLSelectElement).options].map((o) => o.value);
    assert.deepEqual(opOptions(), ["set", "add", "subtract"]);
    await change(selects()[1]!, "met");
    assert.deepEqual(opOptions(), ["set", "toggle"]);
    await change(selects()[2]!, "toggle");
    assert.deepEqual(latest[0], { kind: "set-variable", variableId: "met", op: "toggle" });
  } finally {
    await unmount();
  }
});

test("show-when offers 还没开始聊 and variable conditions", async () => {
  let latest: Condition | undefined;
  function Harness() {
    const [cond, setCond] = useState<Condition | undefined>(undefined);
    latest = cond;
    return createElement(ConditionEditor, { condition: cond, variables, onChange: (next: Condition | undefined) => setCond(next) });
  }
  const { host, unmount } = await mount(createElement(Harness));
  try {
    const mode = () => host.querySelector("select")!;
    await change(mode(), "notStarted");
    assert.deepEqual(latest, { variableId: UI_CHAT_STARTED, operator: "eq", value: false });
    assert.equal(showModeOf(latest), "notStarted");
    await change(mode(), "started");
    assert.equal(showModeOf(latest), "started");

    await change(mode(), "variable");
    assert.deepEqual(latest, { variableId: "hp", operator: "eq", value: 0 });
    const [, variable, op] = [...host.querySelectorAll("select")];
    await change(op!, "gt");
    await change(host.querySelector('input[type="number"]')!, "5");
    assert.deepEqual(latest, { variableId: "hp", operator: "gt", value: 5 });
    await change(variable!, "route");
    assert.deepEqual(latest, { variableId: "route", operator: "eq", value: "a" });

    await change(mode(), "always");
    assert.equal(latest, undefined);
  } finally {
    await unmount();
  }
});
