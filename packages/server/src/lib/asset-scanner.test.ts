import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorldDefinition } from "@yumina/engine";
import { extractAssetRefs, scanAssets } from "./asset-scanner.js";

const IMAGE = "5b00c2bc-4a98-4152-aaeb-e4ef51d7c75d";
const VIDEO = "e4d81cee-be78-4f3b-a0a8-2c9c246df4e7";

test("a [video:] embed is left to the player, pictures beside it are still preloaded", () => {
  assert.deepEqual(extractAssetRefs(`[video:@asset:${VIDEO}]\n\n![](@asset:${IMAGE})`), [IMAGE]);
  assert.deepEqual(extractAssetRefs(`[video: @asset:${VIDEO}]`), []);
});

test("an opening that starts with a clip preloads only its pictures", () => {
  const world = { entries: [{ role: "greeting", enabled: true, content: `[video:@asset:${VIDEO}]\n\nHello ![](@asset:${IMAGE})` }] } as unknown as WorldDefinition;
  const manifest = scanAssets(world);
  assert.deepEqual(manifest.priority, [IMAGE]);
  assert.ok(!manifest.deferred.includes(VIDEO));
});

const refsWorld = (mode?: "automatic" | "on-demand") => ({
  rootComponent: { entryFile: "index.tsx", files: {
    "index.tsx": "@asset:rootentry001", "later.tsx": "@asset:futurecode01",
  }, ...(mode ? { assetLoading: mode } : {}) },
  entries: [{ role: "greeting", enabled: true, content: "@asset:greeting0001" },
    { role: "system", enabled: true, content: "@asset:lorebook0001" }],
  customUI: [{ tsxCode: "@asset:customui0001" }],
  audioTracks: [{ url: "@asset:audiotrack01" }],
  sceneImages: [{ url: "@asset:sceneimage01" }],
}) as unknown as WorldDefinition;

test("legacy and explicit automatic roots retain the existing manifest", () => {
  const messages = [{ content: "@asset:messagefirst" }, { content: "@asset:messagelater" }];
  const expected = { priority: ["rootentry001", "messagefirst", "customui0001"],
    deferred: ["greeting0001", "lorebook0001", "futurecode01", "audiotrack01", "sceneimage01", "messagelater"] };
  assert.deepEqual(scanAssets(refsWorld(), messages), expected);
  assert.deepEqual(scanAssets(refsWorld("automatic"), messages), expected);
  assert.deepEqual(scanAssets(refsWorld()).priority, ["rootentry001", "greeting0001", "customui0001"]);
});

test("on-demand roots emit no generic hints from code, lore, audio, scenes or messages", () => {
  const world = refsWorld("on-demand"), before = structuredClone(world);
  assert.deepEqual(scanAssets(world, [{ content: "@asset:messagefirst" }, { content: "@asset:messagelater" }]), { priority: [], deferred: [] });
  assert.deepEqual(scanAssets(world), { priority: [], deferred: [] });
  assert.deepEqual(world, before);
});

test("resetting on-demand to automatic restores ordinary scanner behavior", () => {
  const world = refsWorld("on-demand");
  assert.deepEqual(scanAssets(world), { priority: [], deferred: [] });
  world.rootComponent!.assetLoading = "automatic";
  assert.ok(scanAssets(world).priority.includes("rootentry001"));
  assert.ok(scanAssets(world).deferred.includes("futurecode01"));
});
