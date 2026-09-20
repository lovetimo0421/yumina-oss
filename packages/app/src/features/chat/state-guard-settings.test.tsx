import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import type { StateGuardSettingsProps } from "../../../sandbox/extensions/state-update-guard/settings";

test("guard controls save Off and a separate model, reload, recover failures, and ignore stale loads", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const original = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById("root")!);
  const vite = await createServer({ root: fileURLToPath(new URL("../../..", import.meta.url)), configFile: false, envFile: false,
    appType: "custom", logLevel: "silent", server: { middlewareMode: true, watch: null }, esbuild: { jsx: "automatic" } });
  const { StateGuardSettingsPanel } = await vite.ssrLoadModule("/sandbox/extensions/state-update-guard/settings.tsx");
  const { StateGuardHistory } = await vite.ssrLoadModule("/sandbox/extensions/state-update-guard/details.tsx");
  let stored = { enabled: true, model: null as string | null };
  const patches: unknown[] = [];
  let failSave = false;
  const props: StateGuardSettingsProps = {
    sessionId: "chat-a",
    load: async () => ({ ...stored }),
    save: async (patch) => { patches.push(patch); if (failSave) throw new Error("offline"); stored = { ...stored, ...patch }; return stored; },
    getModels: async () => [{ id: "custom/correction", name: "Correction" }],
  };
  const render = async (next = props) => { await act(async () => root.render(createElement("div", null,
    createElement(StateGuardSettingsPanel, next), createElement(StateGuardHistory, { key: next.sessionId, records: [{ attemptId: "history-1", outcome: "valid-updates", parsedCount: 7, correctionCount: 1, model: "custom/history", startedAt: new Date().toISOString(), diagnostics: [] }] })))); };
  const history = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes("View history"))!;
  const back = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes("Back"))!;
  const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!;
  const select = () => document.querySelector<HTMLSelectElement>("select")!;
  try {
    await render();
    assert.match(document.body.textContent!, /Paid per correction/);
    assert.equal(select().selectedOptions[0]!.textContent, "Gemini 2.5 Flash Lite");
    const useFree = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === "Use free model");
    await act(async () => useFree()!.click());
    assert.deepEqual(patches.at(-1), { model: "official::openrouter/free" });
    assert.match(document.body.textContent!, /Free updates/);
    assert.equal(useFree(), undefined);
    assert.equal(history().closest('[hidden]'), null);
    assert.doesNotMatch(document.body.textContent!, /Checked commands|Format checking cannot guarantee/);
    assert.equal(toggle().getAttribute("aria-checked"), "true");
    await act(async () => toggle().click());
    assert.deepEqual(patches.at(-1), { enabled: false });
    assert.equal(toggle().textContent, "Off");
    assert.equal(select(), null, "Off hides model settings");
    assert.equal(useFree(), undefined, "Off also hides billing controls");
    assert.match(document.body.textContent!, /This extension is off/);
    assert.doesNotMatch(document.body.textContent!, /Correction model|Changes apply to/);
    await act(async () => history().click());
    assert.match(document.body.textContent!, /Recorded checks/);
    assert.ok(history().closest('[hidden]'), "history navigates away from settings while Off");
    await act(async () => back().click());
    assert.doesNotMatch(document.body.textContent!, /Checked commands/);
    await act(async () => toggle().click());
    await act(async () => { select().value = "custom/correction"; select().dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.deepEqual(patches.at(-1), { model: "custom/correction" });
    assert.deepEqual(stored, { enabled: true, model: "custom/correction" });
    assert.match(document.body.textContent!, /Your API provider may charge; no Yumina mushies/);
    await act(async () => toggle().click());
    await act(async () => root.render(null)); await render();
    assert.equal(toggle().getAttribute("aria-checked"), "false");
    assert.equal(select(), null, "reopened Off stays compact");
    failSave = true;
    await act(async () => toggle().click());
    assert.equal(toggle().getAttribute("aria-checked"), "false");
    assert.ok(document.querySelector('[role="alert"]'));
    failSave = false;
    await act(async () => toggle().click());
    assert.equal(toggle().getAttribute("aria-checked"), "true");
    assert.equal(select().value, "custom/correction", "turning back On restores the selected model");
    await act(async () => history().click());
    assert.match(document.body.textContent!, /Recorded checks/, "history also opens while On");
    await act(async () => back().click());
    await act(async () => { select().value = ""; select().dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.deepEqual(patches.at(-1), { model: null });

    await render({ ...props, sessionId: "missing-models", getModels: async () => { throw new Error("offline"); } });
    assert.ok(toggle(), "model-list failure must not hide the Off switch");
    await act(async () => toggle().click());
    assert.equal(toggle().textContent, "Off");
    assert.doesNotMatch(document.body.textContent!, /Could not load models/, "Off hides model-only errors");

    let resolveOld!: (value: { enabled: boolean; model: string | null }) => void;
    await render({ ...props, sessionId: "slow-chat", load: () => new Promise((resolve) => { resolveOld = resolve; }) });
    await render({ ...props, sessionId: "new-chat", load: async () => ({ enabled: false, model: "custom/new" }) });
    await act(async () => resolveOld({ enabled: true, model: "custom/old" }));
    assert.equal(toggle().textContent, "Off");
    assert.equal(select(), null, "late response cannot reveal another chat's settings");
    assert.equal(history().closest('[hidden]'), null, "switching chats resets history navigation");
    await render({ ...props, readOnly: true, load: async () => { throw new Error("read-only cannot load settings"); } });
    assert.equal(document.querySelector('[role="switch"]'), null);
  } finally {
    await act(async () => root.unmount()); await vite.close(); dom.window.close();
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test("local Guard settings hide official models and billing actions and default to the story BYOK model", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const original = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById("root")!);
  const vite = await createServer({ root: fileURLToPath(new URL("../../..", import.meta.url)), configFile: false, envFile: false,
    appType: "custom", logLevel: "silent", server: { middlewareMode: true, watch: null }, esbuild: { jsx: "automatic" } });
  const { StateGuardSettingsPanel } = await vite.ssrLoadModule("/sandbox/extensions/state-update-guard/settings.tsx");
  let stored = { enabled: true, model: "official::google/gemini-2.5-flash-lite" as string | null, officialModels: false };
  let pickerSelection: string | null = null;
  const patches: unknown[] = [];
  const props: StateGuardSettingsProps = {
    sessionId: "local-chat", storyModel: "custom/story",
    load: async () => stored,
    save: async (patch) => { patches.push(patch); stored = { ...stored, ...patch }; return stored; },
    getModels: async () => [{ id: "official::google/gemini-2.5-flash-lite", name: "Yumina official" }, { id: "private::custom/repair", name: "Own repair model" }],
  };
  try {
    await act(async () => root.render(createElement(StateGuardSettingsPanel, props)));
    assert.doesNotMatch(document.body.textContent!, /Paid per correction|Use free model|Free updates|Gemini|Yumina official|Only saved corrections are charged/);
    assert.match(document.body.textContent!, /Your API provider may charge; no Yumina mushies/);
    const select = document.querySelector<HTMLSelectElement>("select")!;
    assert.equal(select.selectedOptions[0]!.textContent, "custom/story");
    assert.deepEqual([...select.options].map((option) => option.value), ["", "private::custom/repair"]);
    await act(async () => { select.value = "private::custom/repair"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.deepEqual(patches, [{ model: "private::custom/repair" }]);
    await act(async () => root.render(createElement(StateGuardSettingsPanel, { ...props,
      chooseModel: (selected: string | null) => { pickerSelection = selected; },
      renderModel: (model: string | null, onClick: () => void) => createElement("button", { onClick, "data-model-trigger": true }, model),
    })));
    assert.equal(document.querySelector('[data-model-trigger]')!.textContent, "private::custom/repair");
    await act(async () => document.querySelector<HTMLButtonElement>('[data-model-trigger]')!.click());
    assert.equal(pickerSelection, "private::custom/repair");
    stored = { enabled: true, model: null, officialModels: false };
    await act(async () => root.render(createElement(StateGuardSettingsPanel, { ...props, sessionId: "local-default",
      renderModel: (model: string | null, onClick: () => void) => createElement("button", { onClick, "data-model-trigger": true }, model),
      chooseModel: (selected: string | null) => { pickerSelection = selected; },
    })));
    assert.equal(document.querySelector('[data-model-trigger]')!.textContent, "private::custom/story");
  } finally {
    await act(async () => root.unmount()); await vite.close(); dom.window.close();
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
