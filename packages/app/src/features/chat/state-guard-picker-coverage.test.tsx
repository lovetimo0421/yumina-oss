import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import type { StateGuardSettings } from "@yumina/shared";
import type { StateGuardSettingsProps } from "../../../sandbox/extensions/state-update-guard/settings";

test("guard picker callback saves independently, blocks overlapping writes, and ignores a prior chat's save", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById("root")!);
  const vite = await createServer({ root: fileURLToPath(new URL("../../..", import.meta.url)), configFile: false, envFile: false,
    appType: "custom", logLevel: "silent", server: { middlewareMode: true, watch: null }, esbuild: { jsx: "automatic" } });
  const { StateGuardSettingsPanel } = await vite.ssrLoadModule("/sandbox/extensions/state-update-guard/settings.tsx");
  const patches: Partial<StateGuardSettings>[] = [];
  let stored: StateGuardSettings = { enabled: true, model: null };
  let pickerSave!: (model: string) => void;
  let selected: string | null | undefined;
  let pending: ((value: StateGuardSettings) => void) | undefined;
  let delay = false;
  let failLoad = false;
  const props: StateGuardSettingsProps = {
    sessionId: "first-chat",
    load: async () => { if (failLoad) throw new Error("offline"); return { ...stored }; },
    save: async (patch) => {
      patches.push(patch);
      if (delay) return new Promise((resolve) => { pending = resolve; });
      stored = { ...stored, ...patch }; return stored;
    },
    getModels: async () => [{ id: "custom/repair", name: "Repair model" }],
    chooseModel: (value, save) => { selected = value; pickerSave = save; },
  };
  const render = async (next = props) => { await act(async () => root.render(createElement(StateGuardSettingsPanel, next))); };
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === text)!;
  const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!;
  try {
    await render();
    await act(async () => button("Default model").click());
    assert.equal(selected, "official::google/gemini-2.5-flash-lite");
    await act(async () => pickerSave("custom/repair"));
    assert.deepEqual(patches.at(-1), { model: "custom/repair" });
    assert.equal(toggle().getAttribute("aria-checked"), "true", "model selection cannot disable the guard");
    assert.ok(button("Repair model"));
    assert.equal(button("Same as story model"), undefined);

    delay = true;
    const before = patches.length;
    await act(async () => { toggle().click(); toggle().click(); });
    assert.equal(patches.length, before + 1, "one pending write even before React rerenders disabled controls");
    assert.equal(toggle().disabled, true);
    assert.equal(button("Repair model").disabled, true);
    await render({ ...props, sessionId: "second-chat", load: async () => ({ enabled: false, model: "custom/new" }) });
    await act(async () => pending!({ enabled: true, model: "custom/old" }));
    assert.equal(toggle().getAttribute("aria-checked"), "false");
    assert.equal(button("custom/new"), undefined, "Off hides the model even after a prior chat's save completes");
    assert.match(document.body.textContent!, /This extension is off/);
    assert.equal(toggle().disabled, false);

    failLoad = true;
    await render({ ...props, sessionId: "load-retry" });
    assert.ok(document.querySelector('[role="alert"]'));
    assert.equal(document.querySelector('[role="switch"]'), null);
    failLoad = false;
    await act(async () => button("Retry").click());
    assert.ok(toggle(), "retry reloads settings and restores controls");
    assert.equal(document.querySelector('[role="alert"]'), null);
  } finally {
    await act(async () => root.unmount()); await vite.close(); dom.window.close();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test("guard renders a supplied model trigger, saves its selection, and hides it while Off", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById("root")!);
  const vite = await createServer({ root: fileURLToPath(new URL("../../..", import.meta.url)), configFile: false, envFile: false,
    appType: "custom", logLevel: "silent", server: { middlewareMode: true, watch: null }, esbuild: { jsx: "automatic" } });
  const { StateGuardSettingsPanel } = await vite.ssrLoadModule("/sandbox/extensions/state-update-guard/settings.tsx");
  let stored: StateGuardSettings = { enabled: true, model: null };
  const patches: Partial<StateGuardSettings>[] = [];
  const selected: Array<string | null> = [];
  let pickerSave!: (model: string) => void;
  let finishSave!: () => void;
  const props: StateGuardSettingsProps = {
    sessionId: "rendered-trigger-chat",
    load: async () => ({ ...stored }),
    getModels: async () => [],
    save: async (patch) => {
      patches.push(patch);
      if (patch.model) await new Promise<void>((resolve) => { finishSave = resolve; });
      stored = { ...stored, ...patch };
      return stored;
    },
    chooseModel: (model, save) => { selected.push(model); pickerSave = save; },
    renderModel: (model, onClick) => createElement("button", { type: "button", "data-testid": "model-trigger", onClick }, model ?? "Story trigger"),
  };
  const trigger = () => document.querySelector<HTMLButtonElement>('[data-testid="model-trigger"]');
  const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!;
  try {
    await act(async () => root.render(createElement(StateGuardSettingsPanel, props)));
    assert.equal(trigger()!.textContent, "official::google/gemini-2.5-flash-lite");
    await act(async () => trigger()!.click());
    assert.deepEqual(selected, ["official::google/gemini-2.5-flash-lite"], "the supplied trigger opens the Memory default independently of the story");
    await act(async () => pickerSave("custom/correction"));
    assert.deepEqual(patches, [{ model: "custom/correction" }]);
    assert.equal(trigger()!.closest("fieldset")!.disabled, true);
    assert.equal(trigger()!.matches(":disabled"), true, "fieldset disables the supplied trigger during save");
    await act(async () => trigger()!.click());
    assert.equal(selected.length, 1, "a disabled supplied trigger cannot open another picker");
    await act(async () => finishSave());
    assert.equal(trigger()!.textContent, "custom/correction");
    assert.equal(trigger()!.matches(":disabled"), false);
    await act(async () => trigger()!.click());
    assert.deepEqual(selected, ["official::google/gemini-2.5-flash-lite", "custom/correction"]);
    await act(async () => toggle().click());
    assert.equal(trigger(), null);
    assert.match(document.body.textContent!, /This extension is off/);
    await act(async () => toggle().click());
    assert.equal(trigger()!.textContent, "custom/correction", "On restores the supplied trigger's saved model");
    assert.deepEqual(stored, { enabled: true, model: "custom/correction" });
  } finally {
    await act(async () => root.unmount()); await vite.close(); dom.window.close();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
