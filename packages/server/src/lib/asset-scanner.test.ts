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
