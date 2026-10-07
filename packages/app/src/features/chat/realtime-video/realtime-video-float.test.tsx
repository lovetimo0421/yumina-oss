import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { VideoState } from "./controller";

const en = JSON.parse(readFileSync(new URL("../../../locales/en/chat.json", import.meta.url), "utf8")) as Record<string, unknown>;

const noop = () => {};

function fixtureController() {
  let state: VideoState = { status: "idle", engine: "comfy-h3", elapsed: 0, cost: 0, credits: 0, clips: 0,
    waiting: false, currentShot: "", currentStatus: "", muted: true, steps: [], scenes: [], currentScene: null, cut: null };
  const listeners = new Set<() => void>();
  const calls = { start: 0, stop: 0, attach: 0, detach: 0 };
  return { calls, lastShot: "", getState: () => state,
    subscribe: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    attach: () => { calls.attach++; }, detach: () => { calls.detach++; },
    start: async () => { calls.start++; }, stop: () => { calls.stop++; },
    setState: (patch: Partial<VideoState>) => { state = { ...state, ...patch }; listeners.forEach((cb) => cb()); },
  };
}

async function harness(url = "http://localhost", mobile = false, touch = false) {
  const dom = new JSDOM('<div id="root"></div>', { url });
  dom.window.matchMedia = ((query: string) => ({ matches: query === "(pointer: coarse)" ? touch : mobile,
    addEventListener() {}, removeEventListener() {} })) as unknown as typeof dom.window.matchMedia;
  const controllers = new Map<string, ReturnType<typeof fixtureController>>();
  const controller = (id: string) => {
    if (!controllers.has(id)) controllers.set(id, fixtureController());
    return controllers.get(id)!;
  };
  const schema = { rootComponent: { entryFile: "App.tsx", files: {} }, entries: [], variables: [], settings: {} };
  const fixture = { controller,
    chat: { session: { id: "room", world: { schema } }, messages: [], gameState: {}, pendingChoices: [],
      clearError: noop, stopGeneration: noop, setSession: noop, setMessages: noop, setGameState: noop,
      clearPendingChoices: noop, loadSession: noop },
    config: { selectedModel: "fixture", modelPool: [], setConfig: noop },
    ui: { theaterMode: false, playZoomPercent: 100, openSceneGallery: noop },
    userProfile: { profile: { filmOffered: true, preferences: { autoFullscreenOnPlay: false } } },
    extensions: { installState: { "session-memory": "installed", "state-update-guard": "installed" } },
    audio: { cleanup: noop }, models: { models: [], addToRecent: noop },
    credit: { plan: "free" },
    translate: (key: string) => key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], en) ?? key,
  };
  dom.window.scrollTo = noop;
  const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    HTMLInputElement: dom.window.HTMLInputElement,
    Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent, PointerEvent: dom.window.MouseEvent, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (cb: FrameRequestCallback) => { cb(0); return 0; }, cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true, __videoFloatFixture: fixture };
  const original = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById("root")!);
  const appRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const vite = await createServer({ root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
    ssr: { noExternal: ["react-i18next", "@tanstack/react-router"] },
    resolve: { alias: { "@": `${appRoot}/src` } }, server: { middlewareMode: true, watch: null }, esbuild: { jsx: "automatic" },
    // Run the actual host, toolbar, Radix menu, and video float. Replace the provider
    // and unrelated stores/sandbox/dialog surfaces so no account, network, audio,
    // or paid video start can occur. Session/store transitions are driven below.
    plugins: [{ name: "video-provider-fixture", enforce: "pre",
      resolveId(source) {
        if (source === "react-i18next" || source === "@tanstack/react-router") return `\0fixture:${source}`;
      },
      load(id) {
        if (id === "\0fixture:react-i18next") return `export const useTranslation = () => ({ t: globalThis.__videoFloatFixture.translate, i18n: { language: "en", resolvedLanguage: "en" } });`;
        if (id === "\0fixture:@tanstack/react-router") return `export const useRouter = () => ({ history: {} });`;
      },
      transform(_code, id) {
      const path = id.replaceAll("\\", "/");
      if (path.endsWith("/realtime-video/controller.ts")) return `
        export const DIRECTOR_MODELS = [{id: "fixture/director", label: "Fixture"}];
        export const getVideoController = (id) => globalThis.__videoFloatFixture.controller(id);
      `;
      for (const [file, name, key] of [
        ["stores/chat.ts", "useChatStore", "chat"], ["stores/config.ts", "useConfigStore", "config"],
        ["stores/ui.ts", "useUiStore", "ui"], ["stores/user-profile.ts", "useUserProfileStore", "userProfile"],
        ["stores/extensions.ts", "useExtensionsStore", "extensions"], ["stores/audio.ts", "useAudioStore", "audio"],
        ["stores/models.ts", "useModelsStore", "models"],
      ]) if (path.endsWith(`/src/${file}`)) return `export const ${name} = Object.assign((selector) => selector(globalThis.__videoFloatFixture.${key}), { getState: () => globalThis.__videoFloatFixture.${key} });`;
      if (path.endsWith("/src/edition/slots.state.ts")) return `export const useCreditStore = (selector) => selector(globalThis.__videoFloatFixture.credit); export const fetchCreditsForChat = () => {};`;
      if (path.endsWith("/src/edition/edition.ts")) return `export const useFeature = () => false;`;
      if (path.endsWith("/src/lib/utils.ts")) return `export const safeParseWorldDef = (schema) => schema; export const cn = (...items) => items.filter(Boolean).join(" ");`;
      if (path.endsWith("/src/hooks/use-fullscreen.ts")) return `export const useImmersiveMode = () => ({ toggle: () => {} });`;
      if (path.endsWith("/src/features/chat/scene-gallery.tsx")) return `export const SceneGalleryDialog = () => null; export const useSceneGallery = () => ({ images: [{ id: "one" }], revealed: new Set(["one"]) });`;
      for (const [file, names] of [
        ["features/chat/state-guard-host.tsx", ["StateGuardHost", "StateGuardHostButton"]],
        ["features/chat/game-frame.tsx", ["GameFrame"]], ["features/chat/session-header.tsx", ["SessionHeader"]],
        ["features/chat/combat-panel.tsx", ["CombatPanel"]], ["features/chat/world-renderer.tsx", ["WorldRenderer"]],
        ["features/chat/persona-manager-dialog.tsx", ["PersonaManagerDialog"]],
        ["features/chat/share-playthrough-modal.tsx", ["SharePlaythroughModal"]], ["features/chat/model-browser.tsx", ["ModelBrowser"]],
        ["features/chat/use-playtime-tracker.ts", ["usePlaytimeTracker"]],
        ["lib/tts-stop-signal.ts", ["haltTts"]], ["lib/voice-input.ts", ["cancelVoiceRecording"]],
        ["edition/slots.tsx", ["TipModal"]],
      ] as const) if (path.endsWith(`/src/${file}`)) return names.map((name) => `export const ${name} = () => null;`).join("\n");
    } }],
  });
  const { RealtimeVideoFloat } = await vite.ssrLoadModule("/src/features/chat/realtime-video/realtime-video-float.tsx");
  return { dom, controller, fixture, vite, RealtimeVideoFloat,
    render: async (node: ReactNode) => { await act(async () => root.render(node)); },
    close: async () => { await act(async () => root.unmount()); await vite.close(); dom.window.close();
      for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    } };
}

test("authored root worlds have no closed idle video overlay", async () => {
  const h = await harness();
  try {
    await h.render(createElement(h.RealtimeVideoFloat, { sessionId: "room", suppressIdleLauncher: true }));
    assert.equal(document.getElementById("root")!.childElementCount, 0, "idle video launcher must leave the room frame unobstructed");
    assert.equal(h.controller("room").calls.start, 0);
  } finally { await h.close(); }
});

function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.getAttribute("title") === label || item.textContent?.trim() === label);
  assert.ok(found, `Missing button: ${label}`);
  return found;
}

async function click(label: string) { await act(async () => button(label).click()); }

async function selectMenu(label: string) {
  await act(async () => {
    const trigger = button("More actions");
    trigger.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.click();
  });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent?.trim() === label);
  assert.ok(item, `Missing menu item: ${label}`);
  await act(async () => item.click());
}

test("opening and reopening the idle panel never starts video", async () => {
  const h = await harness();
  try {
    const render = (nonce: number) => h.render(createElement(h.RealtimeVideoFloat, {
      sessionId: "room", suppressIdleLauncher: true, openRequest: { sessionId: "room", nonce },
    }));
    await render(1);
    assert.ok(button("Close window (the film keeps going)"));
    await click("Close window (the film keeps going)");
    assert.equal(document.getElementById("root")!.childElementCount, 0);
    await render(1);
    assert.equal(document.getElementById("root")!.childElementCount, 0, "rerendering the same request must not reopen a closed panel");
    await render(2);
    assert.ok(button("Roll camera"));
    await click("Minimize");
    assert.equal(Boolean(document.querySelector('[title="Roll camera"]')), false);
    await render(3);
    assert.ok(button("Roll camera"), "menu requests expand minimized panels");
    assert.equal(h.controller("room").calls.start, 0);
  } finally { await h.close(); }
});

test("closed starting and live video retain reopening and Stop access", async () => {
  for (const status of ["starting", "live"] as const) {
    const h = await harness("http://localhost", true);
    try {
      h.controller("room").setState({ status, elapsed: 12, cost: 0.96 });
      await h.render(createElement(h.RealtimeVideoFloat, { sessionId: "room", suppressIdleLauncher: true }));
      assert.match(document.getElementById("root")!.textContent!, /● 12s/);
      await click("Scene video: film the story as it happens");
      assert.ok(button("Stop"));
      await click("Minimize");
      assert.match(document.getElementById("root")!.textContent!, /●/);
      await click("Minimize");
      await click("Close window (the film keeps going)");
      await click("Scene video: film the story as it happens");
      await click("Stop");
      assert.equal(h.controller("room").calls.stop, 1);
      assert.equal(h.controller("room").calls.start, 0);
      await click("Close window (the film keeps going)");
      await act(async () => h.controller("room").setState({ status: "ended" }));
      assert.equal(document.getElementById("root")!.childElementCount, 0, "closed controls disappear when the stream ends");
    } finally { await h.close(); }
  }
});

test("legacy callers keep their launcher and explicit opening is retained", async () => {
  const h = await harness();
  try {
    await h.render(createElement(h.RealtimeVideoFloat, { sessionId: "legacy" }));
    assert.ok(button("Scene video: film the story as it happens"));
    await h.render(createElement(h.RealtimeVideoFloat, { key: "explicit", sessionId: "explicit", defaultOpen: true, suppressIdleLauncher: true }));
    assert.ok(button("Close window (the film keeps going)"));
    assert.equal(h.controller("explicit").calls.start, 0);
  } finally { await h.close(); }
});

test("requests for a different session cannot open its video panel", async () => {
  const h = await harness();
  try {
    await h.render(createElement(h.RealtimeVideoFloat, { sessionId: "new-room", suppressIdleLauncher: true, openRequest: { sessionId: "old-room", nonce: 1 } }));
    assert.equal(document.getElementById("root")!.childElementCount, 0);
    assert.equal(h.controller("new-room").calls.start, 0);
  } finally { await h.close(); }
});

test("an active stream stays reachable when the real host enters immersive mode", async () => {
  const h = await harness();
  try {
    const { ChatView } = await h.vite.ssrLoadModule("/src/features/chat/chat-view.tsx");
    h.controller("room").setState({ status: "starting", elapsed: 4 });
    await h.render(createElement(ChatView, { sessionId: "room" }));
    h.fixture.ui.theaterMode = true;
    await h.render(createElement(ChatView, { sessionId: "room" }));
    assert.equal(Boolean(document.querySelector('[aria-label="More actions"]')), false);
    await click("Scene video: film the story as it happens");
    assert.ok(button("Stop"));
    await click("Stop");
    assert.equal(h.controller("room").calls.stop, 1);
    assert.equal(h.controller("room").calls.start, 0);
  } finally { await h.close(); }
});

test("the real root ChatView opens Scene video repeatedly through More and isolates sessions", async () => {
  const h = await harness();
  try {
    const { ChatView } = await h.vite.ssrLoadModule("/src/features/chat/chat-view.tsx");
    await h.render(createElement(ChatView, { sessionId: "room" }));
    assert.equal(Boolean(document.querySelector('[title="Scene video: film the story as it happens"]')), false);
    await selectMenu("Scene video");
    assert.ok(button("Close window (the film keeps going)"));
    await click("Close window (the film keeps going)");
    await selectMenu("Scene video");
    assert.ok(button("Close window (the film keeps going)"));
    h.fixture.chat.session = { ...h.fixture.chat.session, id: "second-room" };
    await h.render(createElement(ChatView, { sessionId: "second-room" }));
    assert.equal(Boolean(document.querySelector('[title="Close window (the film keeps going)"]')), false);
    h.fixture.chat.session = { ...h.fixture.chat.session, id: "room" };
    await h.render(createElement(ChatView, { sessionId: "room" }));
    assert.equal(Boolean(document.querySelector('[title="Close window (the film keeps going)"]')), false, "returning to a session must not replay an old menu request");
    assert.equal(h.controller("room").calls.start, 0);
    assert.equal(h.controller("second-room").calls.start, 0);
  } finally { await h.close(); }
});

test("explicit ?rtv opens the panel while embedded preview omits video and its menu action", async () => {
  const h = await harness("http://localhost?rtv=1");
  try {
    const { ChatView } = await h.vite.ssrLoadModule("/src/features/chat/chat-view.tsx");
    await h.render(createElement(ChatView, { sessionId: "room" }));
    assert.ok(button("Close window (the film keeps going)"));
    await h.render(createElement(ChatView, { sessionId: "room", embedded: true }));
    assert.equal(Boolean(document.querySelector('[title="Close window (the film keeps going)"]')), false);
    await act(async () => button("More actions").dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0 })));
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());
    assert.ok(labels.includes("Model"));
    assert.equal(labels.includes("Scene video"), false);
    assert.equal(h.controller("room").calls.start, 0);
  } finally { await h.close(); }
});

test("touch moderation keeps Scene video in More while restricting other host actions", async () => {
  const h = await harness("http://localhost", true, true);
  try {
    const { ChatView } = await h.vite.ssrLoadModule("/src/features/chat/chat-view.tsx");
    const { isTouchDevice } = await h.vite.ssrLoadModule("/src/hooks/use-touch-device.ts");
    assert.equal(isTouchDevice(), true, "run the actual coarse-pointer detection path");
    await h.render(createElement(ChatView, { sessionId: "room", moderationGroupKey: "review-room" }));
    assert.equal(Boolean(document.querySelector('[title="Scene video: film the story as it happens"]')), false);
    assert.equal(Boolean(document.querySelector('[aria-label="Return to fullscreen"]')), false);
    for (let opening = 0; opening < 2; opening++) {
      await click("Show play controls");
      await act(async () => {
        const trigger = button("More actions");
        trigger.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
        trigger.click();
      });
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      assert.deepEqual(items.map((item) => item.textContent?.trim()), ["Scene video"], "restricted moderation retains only video access");
      await act(async () => items[0].click());
      assert.ok(button("Close window (the film keeps going)"));
      await click("Close window (the film keeps going)");
      assert.equal(Boolean(document.querySelector('[title="Scene video: film the story as it happens"]')), false);
    }
    assert.equal(h.controller("room").calls.start, 0);
    assert.equal(h.controller("room").calls.stop, 0);
    await h.render(createElement(ChatView, { sessionId: "room", moderationGroupKey: "review-room", embedded: true }));
    assert.equal(Boolean(document.querySelector('[aria-label="More actions"]')), false, "restricted callers without video keep their prior omission");
    assert.equal(Boolean(document.querySelector('[title="Close window (the film keeps going)"]')), false);
  } finally { await h.close(); }
});

test("Scene video is localized in every supported chat resource", () => {
  for (const locale of ["en", "es", "ja", "zh", "zh-Hant"]) {
    const resource = JSON.parse(readFileSync(new URL(`../../../locales/${locale}/chat.json`, import.meta.url), "utf8"));
    assert.equal(typeof resource.view.sceneVideo, "string", `Missing Scene video label for ${locale}`);
    assert.ok(resource.view.sceneVideo.trim().length > 0);
  }
});
