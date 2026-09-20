import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import type { StateValidationAudit } from "@yumina/shared";
import type { ExtensionClientContext, SlotContribution } from "../../../sandbox/extensions/registry";

async function harness() {
  const dom = new JSDOM('<button id="opener">Open</button><div id="root"></div>', { url: "http://localhost" });
  dom.window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as unknown as typeof dom.window.matchMedia;
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const original = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById("root")!);
  const appRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const vite = await createServer({ root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
    resolve: { alias: { "@": `${appRoot}/src` } },
    server: { middlewareMode: true, watch: null }, esbuild: { jsx: "automatic" },
    // Only replace the iframe-to-host portal transport. The actual guard, history,
    // Memory model picker, provider buttons and sandbox context run unchanged.
    plugins: [{ name: "guard-portal-boundary", enforce: "pre", transform(_code, id) {
      const path = id.replaceAll("\\", "/");
      if (path.endsWith("/sandbox/platform-overlay-portal.tsx")) return "export function SandboxPlatformOverlay({children}) { return children; }";
      if (path.endsWith("/sandbox/platform-overlay-root.ts")) return "export function initializeSandboxPlatformOverlay() { return document.body; }";
    } }],
  });
  return { dom, vite, render: async (node: ReactNode) => { await act(async () => root.render(node)); },
    close: async () => { await act(async () => root.unmount()); await vite.close(); dom.window.close();
      for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    } };
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
  assert.ok(found, `Missing button: ${text}`);
  return found;
}

test("Memory and State Update Guard share the same toolbar pill styling and retain their launchers", async () => {
  const h = await harness();
  try {
    const memory = await h.vite.ssrLoadModule("/sandbox/extensions/session-memory/client.tsx");
    const guard = await h.vite.ssrLoadModule("/sandbox/extensions/state-update-guard/client.tsx");
    const { YuminaContext } = await h.vite.ssrLoadModule("/sandbox/sandbox-context.tsx");
    const slots: SlotContribution[] = [];
    const ctx: ExtensionClientContext = { contribute: (_point, slot) => slots.push(slot), contributeTool() {} };
    memory.default(ctx); guard.default(ctx);
    const api = { language: "en", sessionId: "toolbar-chat", memorySummaryEnabled: true, messages: [],
      selectedModel: "openrouter/free", preferredProvider: "official", userPlan: "free", modelPool: [],
      getStateGuardSettings: async () => ({ enabled: true, model: null }), getModels: async () => ({ models: [] }) };
    const render = () => h.render(createElement(YuminaContext.Provider, { value: api },
      createElement("div", {}, ...slots.map((slot) => createElement(slot.Component, { key: slot.id })))));
    await render();
    const memoryButton = button("Memory");
    const guardButton = button("State Update Guard");
    assert.equal(guardButton.className, memoryButton.className);
    assert.match(guardButton.className, /bg-white\/\[0\.05\]/);
    assert.match(guardButton.className, /py-1\.5/);
    assert.equal(guardButton.querySelector("span")?.className, memoryButton.querySelector("span")?.className);
    for (const pill of [memoryButton, guardButton]) {
      assert.equal(pill.type, "button", "launcher cannot accidentally submit the composer");
      assert.match(pill.querySelector("svg")!.getAttribute("class")!, /h-3\.5 w-3\.5 text-primary\/70 group-hover:text-primary/);
      assert.equal(pill.querySelector("svg")!.getAttribute("aria-hidden"), "true");
    }
    await act(async () => guardButton.click());
    assert.ok(document.querySelector('[role="dialog"][aria-label="State Update Guard"]'));
    await act(async () => button("Close").click());
    assert.equal(document.querySelector('[role="dialog"]'), null);
    api.memorySummaryEnabled = false;
    await render();
    assert.equal([...document.querySelectorAll("button")].some((item) => item.textContent === "Memory"), false);
    assert.ok(button("State Update Guard"), "Memory availability does not gate the guard");
  } finally { await h.close(); }
});

test("guard backdrop and real Memory picker isolate correction provider from the BYOK story", async () => {
  const h = await harness();
  try {
    const { StateGuardModal } = await h.vite.ssrLoadModule("/sandbox/extensions/state-update-guard/client.tsx");
    const { YuminaContext } = await h.vite.ssrLoadModule("/sandbox/sandbox-context.tsx");
    const catalogRequests: unknown[] = [];
    const settingsWrites: unknown[] = [];
    let globalWrites = 0;
    let closed = 0;
    let stored = { enabled: true, model: null as string | null };
    const api = { language: "en", sessionId: "guard-chat", messages: [], readOnly: false, selectedModel: "custom/story",
      preferredProvider: "private", userPlan: "free", mixMode: false, modelPool: [], balance: 100,
      getStateGuardSettings: async () => stored,
      setStateGuardSettings: async (patch: Partial<typeof stored>) => { settingsWrites.push(patch); stored = { ...stored, ...patch }; return stored; },
      getModels: async (provider?: string) => { catalogRequests.push(provider); return { models: [{ id: "custom/story", name: "Private story", provider: "Custom" }], pinnedModels: [], recentlyUsed: [] }; },
      setPreferredProvider: async () => { globalWrites++; return { ok: true }; },
      setModel: () => { globalWrites++; }, setMixMode: () => { globalWrites++; },
      pinModel: async () => ({}), unpinModel: async () => ({}),
    };
    const render = async (open = true) => h.render(createElement(YuminaContext.Provider, { value: api }, createElement(StateGuardModal, { open, onClose: () => { closed++; } })));
    await render();
    const guard = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="State Update Guard"]')!;
    const picker = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Correction model"]');
    assert.doesNotMatch(guard().textContent!, /Same as story model/);
    await act(async () => guard().querySelector("h2")!.click());
    assert.equal(closed, 0, "inside clicks leave the guard open");
    await act(async () => guard().parentElement!.click());
    assert.equal(closed, 1, "outside backdrop closes the guard");
    await render(false); await render(); closed = 0;
    await act(async () => guard().querySelector<HTMLButtonElement>('[data-hint-anchor="model"]')!.click());
    assert.ok(picker());
    assert.equal(button("Yumina API", picker()!).getAttribute("aria-pressed"), "true", "Memory default uses official routing even for a BYOK story");
    assert.equal(picker()!.querySelector('[aria-label="Pin model"]'), null, "extension browsing cannot mutate globally scoped story pins");
    await act(async () => button("Yumina API", picker()!).click());
    assert.equal(globalWrites, 0, "switching correction tabs never switches the story provider");
    assert.equal(settingsWrites.length, 0, "browsing a provider tab is not a saved selection");
    assert.equal(button("Yumina API", picker()!).getAttribute("aria-pressed"), "true");
    await act(async () => button("Private API Key", picker()!).click());
    assert.ok(catalogRequests.includes("private"), "BYOK catalog remains available independently");
    assert.equal(button("Private API Key", picker()!).getAttribute("aria-pressed"), "true");
    await act(async () => picker()!.click());
    assert.equal(picker(), null);
    assert.equal(closed, 0, "closing nested picker does not dismiss guard");
    assert.ok(guard());
    await act(async () => guard().querySelector<HTMLButtonElement>('[data-hint-anchor="model"]')!.click());
    await act(async () => button("Yumina API", picker()!).click());
    const official = [...picker()!.querySelectorAll<HTMLButtonElement>("button")].find((item) => !item.disabled && item.textContent?.includes("Free for everyone"));
    assert.ok(official, "official free model is selectable alongside BYOK models");
    await act(async () => official.click());
    assert.equal(picker(), null);
    assert.equal(globalWrites, 0);
    assert.equal(api.preferredProvider, "private");
    assert.equal(api.selectedModel, "custom/story");
    assert.deepEqual(settingsWrites, [{ model: "official::openrouter/free" }]);
    // Reopen from an official override, then explicitly select a private model.
    await act(async () => guard().querySelector<HTMLButtonElement>('[data-hint-anchor="model"]')!.click());
    assert.equal(button("Yumina API", picker()!).getAttribute("aria-pressed"), "true");
    await act(async () => button("Private API Key", picker()!).click());
    const privateModel = [...picker()!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes("Private story"));
    assert.ok(privateModel);
    await act(async () => privateModel.click());
    assert.deepEqual(settingsWrites.at(-1), { model: "private::custom/story" });
    assert.equal(globalWrites, 0);
    api.preferredProvider = "official";
    api.selectedModel = "openrouter/free";
    await render();
    assert.doesNotMatch(guard().querySelector('[data-hint-anchor="model"]')!.textContent!, /100/, "extension trigger does not display the story wallet balance");
  } finally { await h.close(); }
});

test("local Guard's real picker exposes only BYOK even for imported official preferences", async () => {
  const h = await harness();
  try {
    const { StateGuardModal } = await h.vite.ssrLoadModule("/sandbox/extensions/state-update-guard/client.tsx");
    const { YuminaContext } = await h.vite.ssrLoadModule("/sandbox/sandbox-context.tsx");
    const catalogs: unknown[] = [];
    const writes: unknown[] = [];
    let stored = { enabled: true, model: "official::google/gemini-2.5-flash-lite", officialModels: false };
    const api = { language: "en", sessionId: "local-guard-chat", messages: [], readOnly: false,
      selectedModel: "custom/story", preferredProvider: "official", userPlan: "free", mixMode: false, modelPool: [],
      getStateGuardSettings: async () => stored,
      setStateGuardSettings: async (patch: Partial<typeof stored>) => { writes.push(patch); stored = { ...stored, ...patch }; return stored; },
      getModels: async (provider?: string) => { catalogs.push(provider); return { models: [{ id: "custom/repair", name: "Local repair", provider: "Custom" }], pinnedModels: [], recentlyUsed: [] }; },
      setPreferredProvider: async () => { throw new Error("Guard must not switch story provider"); },
      pinModel: async () => ({}), unpinModel: async () => ({}),
    };
    await h.render(createElement(YuminaContext.Provider, { value: api }, createElement(StateGuardModal, { open: true, onClose() {} })));
    const guard = document.querySelector<HTMLElement>('[role="dialog"][aria-label="State Update Guard"]')!;
    assert.doesNotMatch(guard.textContent!, /Paid per correction|Use free model|Gemini/);
    await act(async () => guard.querySelector<HTMLButtonElement>('[data-hint-anchor="model"]')!.click());
    const picker = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Correction model"]')!;
    assert.ok(picker);
    assert.doesNotMatch(picker.textContent!, /Yumina API|Free for everyone|Gemini/);
    assert.ok(catalogs.includes("private"), "local picker must explicitly fetch BYOK catalog, independent of imported preference");
    const model = [...picker.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes("Local repair"));
    assert.ok(model);
    await act(async () => model.click());
    assert.deepEqual(writes, [{ model: "private::custom/repair" }]);
    assert.equal(api.preferredProvider, "official", "extension routing does not rewrite account settings");
  } finally { await h.close(); }
});

test("history navigates settings/list/call with AI and rule before/after, failed, legacy and no-op records", async () => {
  const h = await harness();
  try {
    const { StateGuardHistory } = await h.vite.ssrLoadModule("/sandbox/extensions/state-update-guard/details.tsx");
    const base: StateValidationAudit = { version: 1, attemptId: "changed", path: "send", outcome: "valid-updates", diagnostics: ["missing_receipt"],
      parsedCount: 1, correctionCount: 1, repaired: true, model: "custom/story", correctionModel: "official/correction",
      apiKeyTier: "byok", startedAt: "2026-09-09T01:00:00Z", baselineFingerprint: "fixture", usageLogIds: [],
      committed: true, changes: [{ variableId: "health", oldValue: 100, newValue: 85, source: "ai" },
        { variableId: "energy", oldValue: 80, newValue: 70, source: "rule" }], correctedBatch: "[health: subtract 15]",
      originalRaw: '{"stateChanges":{"health":100}}', variableNames: { health: "Player health", energy: "Stamina" } };
    const records: StateValidationAudit[] = [base,
      { ...base, attemptId: "original", model: "x-ai/grok-4.20", correctionModel: undefined, correctionCount: 0, repaired: false, diagnostics: [], parsedCount: 8, originalRaw: '[health: -15]\n<yumina-state version="1" status="updated" count="8" />', correctedBatch: undefined, startedAt: "2026-09-09T05:00:00Z" },
      { ...base, attemptId: "failed", model: "failed-model", correctionModel: undefined, outcome: "failed", committed: false, changes: [], startedAt: "2026-09-09T02:00:00Z" },
      { ...base, attemptId: "legacy", model: "legacy-model", correctionModel: undefined, committed: undefined, changes: undefined, startedAt: "2026-09-09T03:00:00Z" },
      { ...base, attemptId: "none", model: "none-model", correctionModel: undefined, outcome: "explicit-none", changes: [], parsedCount: 0, correctionCount: 0, startedAt: "2026-09-09T04:00:00Z" }];
    const render = (key: string) => h.render(createElement(StateGuardHistory, { key, records }, createElement("p", { id: "settings" }, "This extension is off.")));
    await render("chat-a");
    assert.equal(document.querySelector("ol"), null);
    await act(async () => button("View history").click());
    assert.ok(document.getElementById("settings")!.closest("[hidden]"));
    assert.equal(document.querySelectorAll("ol li").length, 5);
    assert.doesNotMatch(document.querySelector("ol")!.textContent!, /model|Commands|Corrections|Checked|custom\//);
    const call = async (model: string) => {
      const record = records.find((item) => (item.correctionModel ?? item.model) === model)!;
      const entry = [...document.querySelectorAll<HTMLButtonElement>("ol button")].find((item) => item.textContent?.includes(new Date(record.startedAt).toLocaleString("en")));
      assert.ok(entry); await act(async () => entry.click());
    };
    const visibleDetail = () => { const clone = document.body.cloneNode(true) as HTMLElement; clone.querySelectorAll("details:not([open]), [hidden]").forEach((node) => node.remove()); return clone.textContent!; };
    await call("official/correction");
    assert.match(document.body.textContent!, /Story model: custom\/story/);
    assert.match(document.body.textContent!, /Correction model: official\/correction/);
    assert.match(visibleDetail(), /Fixed/);
    assert.doesNotMatch(visibleDetail(), /Story model|Correction model|Commands:|Corrections:|Before correction|After correction|required update confirmation/);
    assert.match(visibleDetail(), /Before100After85/);
    const technical = [...document.querySelectorAll("details")].find((node) => node.querySelector("summary")?.textContent === "View technical details")!;
    assert.ok(technical);
    await act(async () => { technical.open = true; });
    assert.match(visibleDetail(), /Story model: custom\/story/);
    await act(async () => { technical.open = false; });
    assert.equal(document.querySelector("ol"), null, "detail replaces list rather than expanding inline");
    assert.equal(document.querySelector("h3")?.textContent, "Call details");
    assert.equal(document.body.textContent!.split("The reply did not include the required update confirmation.").length - 1, 1, "diagnosis appears once, in Before correction");
    assert.equal(document.querySelector('section[aria-live="polite"]'), null, "duplicate summary card is removed");
    assert.equal(document.activeElement, document.querySelector("h3"), "navigation moves focus to detail heading");
    assert.match(document.body.textContent!, /AI updates/); assert.match(document.body.textContent!, /Automatic rules/);
    assert.match(document.body.textContent!, /Before100After85/); assert.match(document.body.textContent!, /Before80After70/);
    assert.match(document.body.textContent!, /Applied/); assert.match(document.body.textContent!, /\[health: subtract 15\]/);
    const comparisonHeadings = [...document.querySelectorAll("h4")].map((heading) => heading.textContent);
    assert.ok(comparisonHeadings.indexOf("Before correction") < comparisonHeadings.indexOf("After correction"));
    assert.match(document.body.textContent!, /Player health: set to 100/);
    assert.match(document.body.textContent!, /Stamina/);
    assert.equal(document.querySelectorAll("details[open]").length, 0, "technical output starts collapsed");
    await act(async () => button("Back").click()); await call("failed-model");
    assert.match(document.body.textContent!, /Not applied/);
    await act(async () => button("Back").click()); await call("legacy-model");
    assert.match(document.body.textContent!, /Correction model: Not recorded/);
    assert.match(document.body.textContent!, /Before\/after details were not recorded for this older call/);
    await act(async () => button("Back").click()); await call("none-model");
    assert.match(visibleDetail(), /No fix needed/); assert.match(document.body.textContent!, /No value changes/);
    assert.doesNotMatch(document.body.textContent!, /details were not recorded/);
    await act(async () => button("Back").click()); await call("x-ai/grok-4.20");
    assert.match(document.body.textContent!, /Story model: x-ai\/grok-4.20/);
    assert.match(document.body.textContent!, /Correction model: Not called/);
    assert.match(document.body.textContent!, /Original reply passed validation/);
    assert.doesNotMatch(document.body.textContent!, /No readable structured|Before correction|After correction/);
    assert.match(visibleDetail(), /No fix needed/);
    assert.doesNotMatch(visibleDetail(), /passed validation|grok|model|commands/i);
    await act(async () => button("Back").click()); await act(async () => button("Back").click());
    assert.equal(document.getElementById("settings")!.closest("[hidden]"), null);
    assert.equal(document.activeElement, button("View history"));
    await act(async () => button("View history").click()); await call("official/correction");
    await render("chat-b");
    assert.equal(document.querySelector("h3"), null, "session-key reset returns to settings");
    assert.equal(document.getElementById("settings")!.closest("[hidden]"), null);
  } finally { await h.close(); }
});

test("open Guard settings and history follow language changes without saving or resetting the chat", async () => {
  const h = await harness();
  try {
    const { StateGuardModal } = await h.vite.ssrLoadModule("/sandbox/extensions/state-update-guard/client.tsx");
    const { YuminaContext } = await h.vite.ssrLoadModule("/sandbox/sandbox-context.tsx");
    const record: StateValidationAudit = { version: 1, attemptId: "locale", path: "send", outcome: "valid-updates",
      diagnostics: [], parsedCount: 1, correctionCount: 0, repaired: false, model: "story", apiKeyTier: "byok",
      startedAt: "2026-09-09T01:00:00Z", baselineFingerprint: "test", usageLogIds: [], committed: true,
      changes: [{ variableId: "health", oldValue: 100, newValue: 85, source: "ai" }], variableNames: { health: "Player health" } };
    let loads = 0;
    const api = { language: "en", sessionId: "locale-chat", selectedModel: "openrouter/free", preferredProvider: "official",
      userPlan: "free", modelPool: [], messages: [{ stateValidation: record }],
      getStateGuardSettings: async () => { loads++; return { enabled: true, model: null }; },
      setStateGuardSettings: async () => { throw new Error("Language changes must not save settings"); },
      getModels: async () => ({ models: [] }) };
    const render = (language: string) => h.render(createElement(YuminaContext.Provider, { value: { ...api, language } },
      createElement(StateGuardModal, { open: true, onClose() {} })));
    await render("en");
    assert.ok(button("Use free model"));
    await render("zh-HK");
    assert.ok(document.querySelector('[role="dialog"][aria-label="狀態更新守衛"]'));
    assert.ok(button("使用免費模型"));
    assert.equal(document.querySelector('[role="switch"]')?.getAttribute("aria-label"), "在此聊天中啟用");
    await act(async () => button("檢視記錄").click());
    assert.ok(document.querySelector("ol")!.textContent!.includes(new Date(record.startedAt).toLocaleString("zh-Hant")));
    await render("ja");
    assert.equal(document.querySelector("h3")?.textContent, "履歴");
    assert.ok(document.querySelector("ol")!.textContent!.includes(new Date(record.startedAt).toLocaleString("ja")));
    await act(async () => document.querySelector<HTMLButtonElement>("ol button")!.click());
    assert.equal(document.querySelector("h3")?.textContent, "呼び出しの詳細");
    await render("es");
    assert.equal(document.querySelector("h3")?.textContent, "Detalles de la llamada");
    assert.match(document.body.textContent!, /No necesita corrección/);
    assert.ok(document.body.textContent!.includes(new Date(record.startedAt).toLocaleString("es")));
    assert.match(document.body.textContent!, /Player health/, "author's variable names stay untouched");
    await act(async () => button("Volver").click());
    await act(async () => button("Volver").click());
    assert.ok(button("Usar modelo gratuito"));
    assert.equal(loads, 1, "language-only changes keep loaded settings and navigation state");
  } finally { await h.close(); }
});
