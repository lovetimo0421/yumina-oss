import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("recovery uses current provider evidence, refreshes without sending and ignores late checks after a card switch", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const values: Record<string, unknown> = { window: dom.window, location: dom.window.location, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const original = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const appRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const vite = await createServer({ root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
    server: { middlewareMode: true, watch: null }, esbuild: { jsx: "automatic" },
    resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": `${appRoot}/../engine/src/index.ts` } } });
  const root = createRoot(document.getElementById("root")!);
  try {
    const { default: i18n } = await vite.ssrLoadModule("/src/lib/i18n.ts");
    await i18n.changeLanguage("en"); await i18n.loadNamespaces(["learning"]);
    const { PlaytestRecovery } = await vite.ssrLoadModule("/src/features/studio/panels/playtest-recovery.tsx");
    const { useChatStore: chat } = await vite.ssrLoadModule("/src/stores/chat.ts");
    const { useConfigStore: config } = await vite.ssrLoadModule("/src/stores/config.ts");
    const { useCreditStore: credit } = await vite.ssrLoadModule("/src/stores/credits.ts");
    const { useModelsStore: models } = await vite.ssrLoadModule("/src/stores/models.ts");
    const { useUserProfileStore: profile } = await vite.ssrLoadModule("/src/stores/user-profile.ts");
    let sends = 0, checks = 0;
    let resolve!: (value: boolean) => void;
    config.setState({ selectedModel: "test-model", mixMode: false, modelPool: [] });
    credit.setState({ provider: "official", lastFetched: Date.now(), balance: 0 });
    chat.setState({ session: { id: "play", worldId: "world" }, isStreaming: false, error: null, lastSendFailure: null, messages: [],
      sendMessage: () => { sends++; }, refreshMessages: () => { checks++; return new Promise<boolean>(r => { resolve = r; }); } });
    await act(async () => root.render(createElement(PlaytestRecovery, { sessionId: "play" })));
    assert.equal(document.querySelector('[role="alert"]'), null, "zero balance alone does not block free or trial models");
    await act(async () => chat.setState({ lastSendFailure: { sessionId: "play", code: "CONNECTION_UNCERTAIN" } }));
    const button = () => [...document.querySelectorAll("button")].find(b => b.textContent?.includes("Check conversation"))!;
    await act(async () => button().click());
    assert.equal(checks, 1); assert.equal(sends, 0);
    assert.ok([...document.querySelectorAll("button")].some(b => b.disabled && b.textContent?.includes("Checking")));
    await act(async () => { chat.setState({ session: { id: "other" }, error: "other error" }); resolve(true); });
    assert.equal(chat.getState().error, "other error", "late checks cannot clear another conversation's failure");
    assert.equal(document.querySelector('[role="alert"]'), null);
    await act(async () => chat.setState({ session: { id: "play" }, error: null }));
    await act(async () => button().click());
    await act(async () => { chat.setState({ messages: [{ id: "arrived", role: "assistant", content: "reply" }] }); resolve(true); });
    assert.equal(chat.getState().lastSendFailure, null, "a recovered reply clears the warning");
    await act(async () => { profile.setState({ profile: { preferences: { preferredProvider: "private" } } }); credit.setState({ provider: "private" }); models.setState({ lastSourceKey: "private:auto", models: [], loading: false }); });
    // Source-key match is deliberately checked via the same resolver the catalog uses.
    const { resolveModelSourceKey } = await vite.ssrLoadModule("/src/stores/models.ts");
    const source = resolveModelSourceKey(credit.getState().provider, credit.getState().lastFetched, profile.getState().profile.preferences);
    await act(async () => models.setState({ lastSourceKey: source }));
    assert.equal(document.querySelector('[data-playtest-recovery]')?.getAttribute('data-playtest-recovery'), "provider");
    await act(async () => models.setState({ lastSourceKey: "old-source" }));
    assert.equal(document.querySelector('[role="alert"]'), null, "stale catalog data is not an empty-provider warning");
    assert.equal(sends, 0);
  } finally {
    await act(async () => root.unmount()); await vite.close(); dom.window.close();
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
