import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { JSDOM } from "jsdom";
import type { Variable, WorldEntry } from "@yumina/engine";
import { VariableActivationEditor } from "./variable-activation-editor";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { editor: {
  variables: { activationLabel: "Activation", activationModes: { always: "Always", conditions: "Conditions", greeting: "Openings", manual: "Manual" }, enabledDefaultLabel: "Initial switch" },
  blueprint: { insp: { logicLabel: "Match" }, logic: { all: "All", any: "Any" } },
  conditionEditor: { addCondition: "Add condition", conditions: "Conditions", trueValue: "True", falseValue: "False" },
} } } });

const vars: Variable[] = [
  { id: "hp", name: "Health", type: "number", defaultValue: 10 },
  { id: "limit", name: "Limit", type: "number", defaultValue: 3 },
  { id: "key", name: "Has key", type: "boolean", defaultValue: false },
  { id: "bag", name: "Inventory", type: "json", defaultValue: {} },
];
const opening = (id: string): WorldEntry => ({ id, name: id, content: "An opening", role: "greeting", section: "system-presets", position: 0, enabled: true, alwaysSend: true, keywords: [], conditions: [], conditionLogic: "all" });

async function withEditor(initial: Variable, greetings: WorldEntry[], run: (context: {
  container: HTMLElement;
  current: () => Variable;
  mode: (name: string) => Promise<void>;
  click: (element: Element) => Promise<void>;
  changeSelect: (element: HTMLSelectElement, value: string) => Promise<void>;
  replace: (variable: Variable) => Promise<void>;
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  let variable = initial;
  const render = () => root.render(createElement(I18nextProvider, { i18n }, createElement(VariableActivationEditor, {
    variable, variables: vars, greetings,
    onChange: (updates) => { variable = { ...variable, ...updates }; render(); },
  })));
  const click = async (element: Element) => { await act(async () => { element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); }); };
  const mode = async (name: string) => {
    const button = [...container.querySelectorAll('[aria-label="Activation"] button')].find((node) => node.textContent === name);
    assert.ok(button, `mode ${name} is offered`);
    await click(button);
  };
  try {
    await act(async () => render());
    await run({ container, current: () => variable, mode, click,
      changeSelect: async (element, value) => { await act(async () => { element.value = value; element.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); },
      replace: async (next) => { variable = next; await act(async () => render()); },
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("the same inspector controls preserve multiple typed conditions and all/any through mode changes", async () => {
  const conditions = [
    { variableId: "hp", operator: "gte" as const, value: 0, valueRef: "limit" },
    { variableId: "key", operator: "eq" as const, value: true },
    { variableId: "bag", operator: "eq" as const, value: { weapon: "sword" } },
  ];
  await withEditor({ ...vars[0]!, activation: { mode: "conditions", conditions, conditionLogic: "any" } }, [], async ({ container, mode, current, click, changeSelect }) => {
    assert.deepEqual(current().activation, { mode: "conditions", conditions, conditionLogic: "any" });
    assert.ok([...container.querySelectorAll("select")].some((select) => select.value === "limit"), "variable operands are editable");
    assert.ok([...container.querySelectorAll("input")].some((input) => input.value === '{"weapon":"sword"}'), "JSON values are shown intact");
    await mode("Always");
    assert.equal(current().activation, undefined);
    await mode("Conditions");
    assert.deepEqual(current().activation, { mode: "conditions", conditions, conditionLogic: "any" });
    const all = [...container.querySelectorAll('[aria-label="Match"] button')].find((button) => button.textContent === "All")!;
    await click(all);
    const activation = current().activation;
    assert.ok(activation?.mode === "conditions");
    assert.equal(activation.conditionLogic, "all");
    assert.deepEqual(activation.conditions, conditions);
    const booleanSelect = [...container.querySelectorAll("select")].find((select) => select.querySelector('option[value="true"]'))!;
    await changeSelect(booleanSelect, "false");
    const changed = current().activation;
    assert.ok(changed?.mode === "conditions");
    assert.equal(changed.conditions[1]!.value, false);
    assert.deepEqual(changed.conditions[0], conditions[0]);
    assert.deepEqual(changed.conditions[2], conditions[2]);
    const row = booleanSelect.parentElement!;
    await click(row.querySelector("button")!);
    const removed = current().activation;
    assert.ok(removed?.mode === "conditions");
    assert.deepEqual(removed.conditions, [conditions[0], conditions[2]]);
  });
});

test("empty conditions and openings explain actual behavior and opening choices remain editable", async () => {
  await withEditor(vars[0]!, [opening("town"), opening("mine")], async ({ container, mode, current, click }) => {
    await mode("Conditions");
    assert.match(container.querySelector('[role="status"]')?.textContent ?? "", /no restriction/);
    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Add condition")!);
    const added = current().activation;
    assert.ok(added?.mode === "conditions");
    assert.equal(added.conditions.length, 1);
    assert.equal(container.querySelector('[role="status"]'), null);
    await mode("Openings");
    assert.match(container.querySelector('[role="status"]')?.textContent ?? "", /stay inactive/);
    const mine = [...container.querySelectorAll("label")].find((label) => label.textContent?.includes("mine"))!.querySelector("input")!;
    await click(mine);
    assert.deepEqual(current().activation, { mode: "greeting", greetingIds: ["mine"] });
    await mode("Always");
    await mode("Openings");
    assert.deepEqual(current().activation, { mode: "greeting", greetingIds: ["mine"] });
  });
});

test("manual default switches stay recoverable in other modes and drafts do not leak to another variable", async () => {
  await withEditor({ ...vars[0]!, enabled: false, activation: { mode: "greeting", greetingIds: ["deleted-opening"] } }, [], async ({ container, mode, current, click, replace }) => {
    assert.match(container.textContent ?? "", /Missing opening: deleted-opening/);
    await mode("Always");
    assert.match(container.textContent ?? "", /initial switch is off/);
    await click(container.querySelector('input[type="checkbox"]')!);
    assert.equal(current().enabled, undefined);
    await mode("Conditions");
    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Add condition")!);
    await replace(vars[2]!);
    await mode("Conditions");
    assert.deepEqual(current().activation, { mode: "conditions", conditions: [], conditionLogic: "all" });
  });
});
