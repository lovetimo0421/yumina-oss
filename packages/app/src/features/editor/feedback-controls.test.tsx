import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, createElement, type ReactElement } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
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
  resolve: { alias: { "@": fileURLToPath(new URL("../..", import.meta.url)) } },
  esbuild: { jsx: "automatic" }, server: { middlewareMode: true },
});
const { AudioSection } = await vite.ssrLoadModule("/src/features/editor/sections/audio.tsx") as typeof import("./sections/audio");
const { ReviewStateControl } = await vite.ssrLoadModule("/src/features/editor/review-state-control.tsx") as typeof import("./review-state-control");
const { useEditorStore } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("@/stores/editor");
const { useUserProfileStore } = await vite.ssrLoadModule("/src/stores/user-profile.ts") as typeof import("@/stores/user-profile");
const { useWorldsStore } = await vite.ssrLoadModule("/src/stores/worlds.ts") as typeof import("@/stores/worlds");
const { feedback } = await vite.ssrLoadModule("/src/lib/feedback.tsx") as typeof import("@/lib/feedback");
const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { editor: JSON.parse(readFileSync(new URL("../../locales/en/editor.json", import.meta.url), "utf8")), admin: {} } }, interpolation: { escapeValue: false } });
const realFetch = globalThis.fetch;
const savedEditor = useEditorStore.getState();
after(async () => {
  useEditorStore.getState().stopAutosave();
  globalThis.fetch = realFetch;
  await vite.close();
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

async function render(element: ReactElement, run: () => Promise<void>) {
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(I18nextProvider, { i18n }, element)));
    await run();
  } finally { await act(async () => root.unmount()); useEditorStore.getState().stopAutosave(); }
}

test("audio editor copies the track ID, preserves it on rename, and persists the AI toggle", async () => {
  useEditorStore.setState({ worldDraft: { ...savedEditor.worldDraft, audioTracks: [{ id: "track-123", name: "Music", url: "@asset:file-456", type: "bgm" }] }, isDirty: false, serverWorldId: null });
  let copied = "";
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
  await render(createElement(AudioSection), async () => {
    assert.equal(dom.window.document.querySelectorAll("#audio-track-id").length, 1);
    assert.equal(dom.window.document.querySelectorAll('[aria-label="Copy ID"]').length, 1);
    assert.equal(dom.window.document.querySelector<HTMLInputElement>("#audio-track-id")?.value, "track-123");
    assert.ok(dom.window.document.body.textContent?.includes('api.playAudio("track-123")'));
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Copy ID"]')!.click());
    assert.equal(copied, "track-123");
    const checkbox = dom.window.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    assert.equal(checkbox.checked, true, "old tracks allow AI by default");
    await act(async () => checkbox.click());
    assert.equal(useEditorStore.getState().worldDraft.audioTracks[0]?.allowAiControl, false);
    await act(async () => useEditorStore.getState().updateAudioTrack("track-123", { name: "Renamed" }));
    assert.equal(dom.window.document.querySelector<HTMLInputElement>("#audio-track-id")?.value, "track-123");
    assert.equal(checkbox.checked, false);
    assert.equal(useEditorStore.getState().isDirty, true);
  });
});

test("clipboard rejection provides manual-copy guidance without changing the track", async () => {
  const originalError = feedback.error;
  let error = "";
  feedback.error = ((message: unknown) => { error = String(message); return () => {}; }) as typeof feedback.error;
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
  try {
    await render(createElement(AudioSection), async () => {
      await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Copy ID"]')!.click());
      assert.equal(error, i18n.t("editor:audio.trackIdCopyFailed"));
      assert.equal(dom.window.document.querySelector<HTMLInputElement>("#audio-track-id")?.value, "track-123");
    });
  } finally { feedback.error = originalError; }
});

test("unsubmitted updates use the draft label and the creator's correct publishing action", async () => {
  for (const trusted of [false, true]) {
    useUserProfileStore.setState({ profile: { id: "creator", skipReview: trusted, isBanned: false } as NonNullable<ReturnType<typeof useUserProfileStore.getState>["profile"]> });
    useEditorStore.setState({ serverWorldId: "card", worldStatus: "published", worldIsPublished: true, readOnlyInspect: false, pendingEdit: { status: "draft", reasons: ["entries"], submittedAt: null, updatedAt: "2026-09-05T00:00:00Z", rejectionReason: null, rejectionDetail: null } });
    await render(createElement(ReviewStateControl, { onPublish: () => {} }), async () => {
      const trigger = dom.window.document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
      assert.equal(trigger.textContent, "Unpublished changes");
      await act(async () => trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      const text = dom.window.document.body.textContent!;
      assert.ok(text.includes(trusted ? "Publish update" : "Submit for review"), text);
      assert.ok(text.includes(trusted ? "without waiting for an admin" : "have not been submitted"), text);
      assert.ok(!text.includes("Update in review"));
    });
  }
});

test("submitting saves first and stops for failed saves, newer typing, or navigation", async () => {
  for (const outcome of ["saved", "failed", "typing", "navigated"] as const) {
    const calls: string[] = [];
    useWorldsStore.setState({ invalidate: () => {}, fetchWorlds: async () => {} });
    useEditorStore.setState({ serverWorldId: "card", isDirty: true, pendingEdit: { status: "draft", reasons: ["entries"] } as NonNullable<typeof savedEditor.pendingEdit>,
      saveDraft: async () => { calls.push("save"); if (outcome === "saved") useEditorStore.setState({ isDirty: false }); if (outcome === "navigated") useEditorStore.setState({ serverWorldId: "other", isDirty: false }); return outcome !== "failed"; },
      refreshWorldSchema: async () => { calls.push("refresh"); },
    });
    globalThis.fetch = async () => { calls.push("submit"); return new Response(JSON.stringify({ data: { autoApproved: true, pendingEdit: null } })); };
    assert.equal(await useEditorStore.getState().submitPendingEdit(), outcome === "saved");
    assert.deepEqual(calls, outcome === "saved" ? ["save", "submit", "refresh"] : ["save"]);
    if (outcome === "saved") assert.equal(useEditorStore.getState().pendingEdit, null);
  }
  useEditorStore.setState({ saveDraft: savedEditor.saveDraft, refreshWorldSchema: savedEditor.refreshWorldSchema });
  globalThis.fetch = realFetch;
});

test("the profile response exposes trusted publishing eligibility", async () => {
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: { id: "creator", skipReview: true, isBanned: false } }));
    await useUserProfileStore.getState().forceFetchProfile();
    assert.equal(useUserProfileStore.getState().profile?.skipReview, true);
    assert.equal(useUserProfileStore.getState().profile?.isBanned, false);
  } finally { globalThis.fetch = realFetch; }
});

test("post-publish refresh preserves typing and updates the server version", async () => {
  const base = { ...savedEditor.worldDraft, id: "card", name: "Original", audioTracks: [] };
  useEditorStore.setState({ serverWorldId: "card", worldDraft: { ...base, name: "Typed during publish" }, _baseSchema: base, isDirty: true, refreshWorldSchema: savedEditor.refreshWorldSchema });
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: { id: "card", name: "Original", schema: base, status: "published", isPublished: true, pendingEdit: null, updatedAt: "2026-09-05T12:00:00Z" } }));
    await useEditorStore.getState().refreshWorldSchema();
    assert.equal(useEditorStore.getState().worldDraft.name, "Typed during publish");
    assert.equal(useEditorStore.getState().isDirty, true);
    assert.equal(useEditorStore.getState().baseUpdatedAt, "2026-09-05T12:00:00Z");
    assert.equal(useEditorStore.getState().pendingEdit, null);
  } finally { globalThis.fetch = realFetch; }
});

test("refresh cannot replace another card after navigation", async () => {
  useEditorStore.setState({ serverWorldId: "card", isDirty: false, worldDraft: { ...savedEditor.worldDraft, name: "New card" } });
  try {
    globalThis.fetch = async () => {
      useEditorStore.setState({ serverWorldId: "other" });
      return new Response(JSON.stringify({ data: { id: "card", name: "Old card", schema: savedEditor.worldDraft } }));
    };
    await useEditorStore.getState().refreshWorldSchema();
    assert.equal(useEditorStore.getState().worldDraft.name, "New card");
  } finally { globalThis.fetch = realFetch; }
});

test("every UI language distinguishes a saved draft from a queued review", () => {
  for (const locale of ["en", "zh", "zh-Hant", "ja", "es"]) {
    const source = readFileSync(new URL(`../../locales/${locale}/editor.json`, import.meta.url), "utf8");
    for (const key of ["trackId", "copyTrackId", "trackIdCopied", "trackIdCopyFailed", "trackIdHelp", "allowAiControl"]) {
      assert.equal([...source.matchAll(new RegExp(`^    "${key}":`, "gm"))].length, 1, `${locale}: unique ${key}`);
    }
    const editor = JSON.parse(source);
    assert.notEqual(editor.review.stateControl.chipHeldDraft, editor.review.stateControl.chipInReview);
    assert.notEqual(editor.review.pendingEdit.autoPublishBody, editor.review.pendingEdit.heldBody);
    assert.ok(editor.review.pendingEdit.publishBtn);
  }
});
