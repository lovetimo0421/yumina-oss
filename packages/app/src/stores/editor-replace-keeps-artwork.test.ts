import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";
import type { WorldDefinition } from "@yumina/engine";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
} });
const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const vite = await createServer({
  root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
  server: { middlewareMode: true, watch: null },
  resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": `${appRoot}/../engine/src/index.ts` } },
});
const { useEditorStore: store } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
after(async () => {
  store.getState().stopAutosave();
  await vite.close();
});

// A file exported from a base card: it carries the base card's artwork.
function baseFile(): WorldDefinition {
  return {
    ...structuredClone(store.getState().worldDraft),
    name: "URPG world v2",
    avatar: "https://cdn/base-cover.png",
    coverCrop: { x: 1, y: 1, zoom: 2 } as never,
    landscapeCover: "https://cdn/base-banner.png",
    landscapeCoverCrop: { x: 3, y: 3, zoom: 1 } as never,
  };
}

test("replacing a card from a file keeps its own cover and banner", () => {
  const own = structuredClone(store.getState().worldDraft);
  store.setState({
    serverWorldId: "card",
    worldDraft: {
      ...own,
      avatar: "https://cdn/own-cover.png",
      landscapeCover: "https://cdn/own-banner.png",
    },
  });
  store.getState().loadWorldDefinition(baseFile(), { preserveServerState: true });
  const d = store.getState().worldDraft;
  assert.equal(d.name, "URPG world v2");
  assert.equal(d.avatar, "https://cdn/own-cover.png");
  assert.deepEqual(d.coverCrop, own.coverCrop);
  assert.equal(d.landscapeCover, "https://cdn/own-banner.png");
  assert.deepEqual(d.landscapeCoverCrop, own.landscapeCoverCrop);
});

test("a card without a banner does not take the file's banner", () => {
  const own = structuredClone(store.getState().worldDraft);
  delete own.landscapeCover;
  delete own.landscapeCoverCrop;
  store.setState({ serverWorldId: "card", worldDraft: { ...own, avatar: "https://cdn/own-cover.png" } });
  store.getState().loadWorldDefinition(baseFile(), { preserveServerState: true });
  assert.equal(store.getState().worldDraft.landscapeCover, undefined);
});

test("a fresh import still takes the file's artwork", () => {
  store.getState().loadWorldDefinition(baseFile());
  const d = store.getState().worldDraft;
  assert.equal(d.avatar, "https://cdn/base-cover.png");
  assert.equal(d.landscapeCover, "https://cdn/base-banner.png");
});
