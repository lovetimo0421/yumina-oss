import assert from "node:assert/strict";
import test, { after } from "node:test";
import { act, createElement } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { JSDOM } from "jsdom";
import type { WorldDefinition } from "@yumina/engine";
import { VariableIdEditor } from "./variable-id-editor";

const dom = new JSDOM('<!doctype html><div id="root"></div><button id="outside">Outside</button>', { pretendToBeVisual: true });
const globals = { window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { editor: { variables: { id: "Variable ID", idTaken: "Assigned {{id}}" } } } } });
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

async function withEditor(referenced: boolean, run: (context: {
  container: HTMLElement;
  calls: string[];
  input: () => HTMLInputElement;
  type: (value: string) => Promise<void>;
  blur: () => Promise<void>;
  apply: () => Promise<void>;
  setAssigned: (value: string) => void;
}) => Promise<void>) {
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  let world: WorldDefinition = { id: "world", name: "Card", author: "", description: "", version: "1", variables: [{ id: "hp", name: "Health", type: "number", defaultValue: 10 }], entries: referenced ? [{ id: "opening", name: "Opening", role: "greeting", section: "system-presets", content: "{{hp}}", conditions: [], conditionLogic: "all", enabled: true, alwaysSend: true, position: 0, keywords: [] }] : [], rules: [], components: [], customUI: [], audioTracks: [], settings: {} };
  const calls: string[] = [];
  let assigned: string | undefined;
  const render = () => root.render(createElement(I18nextProvider, { i18n }, createElement(VariableIdEditor, { world, variable: world.variables[0]!, onCommit: (next) => {
    calls.push(next);
    const actual = assigned ?? next;
    world = { ...world, variables: [{ ...world.variables[0]!, id: actual }] };
    render();
    return actual;
  } })));
  const input = () => container.querySelector("input")!;
  try {
    await act(async () => render());
    await run({ container, calls, input,
      type: async (value) => { await act(async () => { input().focus(); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input(), value); input().dispatchEvent(new dom.window.Event("input", { bubbles: true })); }); },
      blur: async () => { await act(async () => { (dom.window.document.getElementById("outside") as HTMLButtonElement).focus(); }); },
      apply: async () => { await act(async () => { container.querySelector("button")!.click(); }); },
      setAssigned: (value) => { assigned = value; },
    });
  } finally { await act(async () => root.unmount()); }
}

test("typing an ID never commits; blur commits once and preserves a collision explanation", async () => {
  await withEditor(false, async ({ container, calls, input, type, blur, setAssigned }) => {
    await type("new");
    await type("new_id");
    assert.deepEqual(calls, []);
    setAssigned("new_id_2");
    await blur();
    assert.deepEqual(calls, ["new_id"]);
    assert.equal(input().value, "new_id_2");
    assert.match(container.textContent!, /Assigned new_id_2/);
  });
});

test("a referenced ID stays as an editable local draft with an explicit error and actual usage", async () => {
  await withEditor(true, async ({ container, calls, input, type, apply, blur }) => {
    assert.match(container.textContent!, /Opening/);
    assert.match(container.textContent!, /entries\[0\]\.content/);
    await type("life");
    await apply();
    assert.deepEqual(calls, []);
    assert.equal(input().value, "life", "a refusal does not silently replace the typed draft");
    assert.equal(input().getAttribute("aria-invalid"), "true");
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /ID is in use/);
    await blur();
    assert.deepEqual(calls, []);
    assert.equal(input().value, "life");
  });
});

test("an empty draft explains its refusal and correcting it can be submitted", async () => {
  await withEditor(false, async ({ container, calls, input, type, apply }) => {
    await type("");
    await apply();
    assert.deepEqual(calls, []);
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /Enter an ID/);
    await type(" life ");
    await apply();
    assert.deepEqual(calls, ["life"]);
    assert.equal(input().value, "life");
  });
});
