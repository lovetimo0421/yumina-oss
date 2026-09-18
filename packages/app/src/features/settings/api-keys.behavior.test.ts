import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator, location: dom.window.location,
  localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element,
  Node: dom.window.Node, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const vite = await createServer({
  configFile: false, root: fileURLToPath(new URL("../../..", import.meta.url)), appType: "custom", logLevel: "silent",
  resolve: { alias: {
    "@": fileURLToPath(new URL("../..", import.meta.url)),
    "@yumina/engine": fileURLToPath(new URL("../../../../engine/src/index.ts", import.meta.url)),
    "@yumina/shared": fileURLToPath(new URL("../../../../shared/src/index.ts", import.meta.url)),
  } },
  esbuild: { jsx: "automatic" }, server: { middlewareMode: true },
});
const { ApiKeysSettings } = await vite.ssrLoadModule("/src/features/settings/api-keys.tsx") as typeof import("./api-keys");
const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { profile: JSON.parse(readFileSync(new URL("../../locales/en/profile.json", import.meta.url), "utf8")) } }, interpolation: { escapeValue: false } });
const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await vite.close();
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
function button(label: string) {
  const match = [...dom.window.document.querySelectorAll("button")].find(node => node.textContent?.trim() === label);
  assert.ok(match, `Missing button: ${label}`);
  return match;
}
function modelField() {
  return dom.window.document.querySelector<HTMLInputElement>('input[placeholder="Enter the full model ID that works in your other app"]')!;
}
async function input(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function render(run: (calls: string[]) => Promise<void>, reply: unknown = { ok: true, reply: "Hello" }, pending?: Promise<Response>) {
  const calls: string[] = [];
  const entry = { id: "custom-profile", provider: "custom", label: "Featherless", baseUrl: "https://api.example.com/v1", metadata: { defaultModel: "manual/model" }, createdAt: "2026-09-12" };
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/list-models")) return pending ?? json({ data: { ok: false, code: "model_list_unavailable", status: 404 } });
    if (path.endsWith("/test")) return json({ data: reply });
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      if (patch.defaultModel !== undefined) entry.metadata.defaultModel = patch.defaultModel;
      return json({ data: entry });
    }
    return json({ data: [entry] });
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(ApiKeysSettings))));
    await run(calls);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = realFetch;
  }
}

test("unavailable discovery leaves the manual model usable and a real reply establishes test success", async () => {
  await render(async (calls) => {
    await act(async () => button("Fetch models").click());
    const warning = [...dom.window.document.querySelectorAll("div")].find(node => node.textContent === "Could not fetch the model list (HTTP 404). Enter a model ID and send a test message.");
    assert.ok(warning?.className.includes("text-amber-200"));
    assert.equal(modelField().disabled, false);
    assert.equal(button("Send test message").disabled, false);
    await act(async () => button("Send test message").click());
    assert.ok(dom.window.document.body.textContent?.includes("Test successful"));
    assert.ok(!dom.window.document.body.textContent?.includes("Could not fetch the model list"));
    assert.equal(calls.filter(call => call.endsWith("/test")).length, 1);
    await input(modelField(), "another/model");
    assert.ok(!dom.window.document.body.textContent?.includes("Test successful"), "changing the model invalidates the previous result");
  });
});

test("an empty successful payload cannot be displayed as a successful generation", async () => {
  await render(async () => {
    await act(async () => button("Send test message").click());
    assert.ok(!dom.window.document.body.textContent?.includes("Test successful"));
    assert.ok(dom.window.document.body.textContent?.includes("Test failed"));
  }, { ok: true, reply: "   " });
});

test("saving a manual model never triggers model discovery for a custom profile", async () => {
  await render(async (calls) => {
    await input(modelField(), "another/model");
    await act(async () => button("Save").click());
    assert.ok(calls.some(call => call.startsWith("PATCH")));
    assert.ok(!calls.some(call => call.endsWith("/list-models")));
    assert.equal(modelField().value, "another/model");
  });
});

test("pending discovery locks credentials, model edits and competing requests", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  await render(async () => {
    await act(async () => button("Fetch models").click());
    assert.equal(modelField().disabled, true);
    assert.equal(button("Send test message").disabled, true);
    assert.equal(button("Additional params").disabled, true);
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[name="profile-custom-profile-api-key"]')!.disabled, true);
    await act(async () => finish(json({ data: { ok: false, code: "model_list_unavailable", status: 404 } })));
    assert.equal(modelField().disabled, false);
    assert.equal(button("Send test message").disabled, false);
  }, undefined, pending);
});
