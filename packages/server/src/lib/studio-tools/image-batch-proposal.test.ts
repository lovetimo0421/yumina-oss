import test from "node:test";
import assert from "node:assert/strict";
import { SMART_IMAGE_MODEL } from "@yumina/shared";
import { editImageBatchProposal, estimateImageBatch, normalizeImageBatchProposal } from "./image-batch-proposal.js";
import { STUDIO_TOOLS, CONTROL_TOOL_NAMES } from "./tools.js";

const colors = ["black", "brown", "blonde", "red", "silver", "blue", "pink", "purple", "green", "white"];
const freeBatch = () => ({ items: colors.map(color => ({ id: color, label: `${color} hair`, prompt: `An adult woman with ${color} hair, a separate portrait, natural lighting.` })) });

test("ten distinct hair-color portraits remain ten independent library images", () => {
  const batch = normalizeImageBatchProposal(freeBatch());
  assert.ok(batch);
  assert.equal(batch.items.length, 10);
  assert.equal(new Set(batch.items.map(item => item.prompt)).size, 10);
  assert.ok(batch.items.every(item => !item.target));
  assert.deepEqual(estimateImageBatch(batch, { [SMART_IMAGE_MODEL]: 35 }), { unitMushies: 35, estimatedMushies: 350 });
  assert.ok(CONTROL_TOOL_NAMES.has("generate_images"));
  assert.ok(STUDIO_TOOLS.some(tool => tool.function.name === "generate_images"));
});

test("batch is bounded without silently truncating outputs or invalid prompts", () => {
  for (const items of [[], Array.from({ length: 31 }, (_, i) => ({ id: `i${i}`, label: "portrait", prompt: "a portrait" })),
    [{ id: "a", label: "a", prompt: " " }], [{ id: "a", label: "a", prompt: "x".repeat(2001) }]]) {
    assert.equal(normalizeImageBatchProposal({ items }), null);
  }
  assert.equal(normalizeImageBatchProposal({ ...freeBatch(), model: "unknown" }), null);
});

test("duplicate item IDs and portrait targets cannot charge twice for one slot", () => {
  assert.equal(normalizeImageBatchProposal({ items: [freeBatch().items[0], freeBatch().items[0]] }), null);
  const items = freeBatch().items.slice(0, 2).map(item => ({ ...item, target: { kind: "entry_portrait", entryId: "alice" } }));
  assert.equal(normalizeImageBatchProposal({ items }), null);
});

test("confirmation edits select known items and preserve server-owned binding targets", () => {
  const batch = normalizeImageBatchProposal({ items: [{ id: "alice", label: "Alice", prompt: "A portrait", target: { kind: "entry_portrait", entryId: "alice" } }] })!;
  const edited = editImageBatchProposal(batch, { items: [{ id: "alice", prompt: "A new portrait", label: "Injected", target: { kind: "entry_portrait", entryId: "someone-else" } }], estimatedMushies: 0 });
  assert.deepEqual(edited?.items[0], { id: "alice", label: "Alice", prompt: "A new portrait", target: { kind: "entry_portrait", entryId: "alice" } });
  assert.equal(editImageBatchProposal(batch, { items: [{ id: "unknown" }] }), null);
  assert.equal(editImageBatchProposal(batch, { items: [{ id: "alice" }, { id: "alice" }] }), null);
  assert.equal(editImageBatchProposal(batch, { items: [] }), null);
});

test("4K costs and existing pictures are reflected in the approval estimate", () => {
  const batch = normalizeImageBatchProposal({ ...freeBatch(), resolution: "4K" })!;
  batch.items[0]!.existingAssetId = "@asset:already-there";
  assert.deepEqual(estimateImageBatch(batch, { [SMART_IMAGE_MODEL]: 35 }), { unitMushies: 52.5, estimatedMushies: 472.5 });
  assert.equal(editImageBatchProposal(batch, { items: [{ id: "black" }] }), null);
  assert.throws(() => estimateImageBatch(batch, {}), /IMAGE_ESTIMATE_UNAVAILABLE/);
  assert.throws(() => estimateImageBatch(batch, { [SMART_IMAGE_MODEL]: NaN }), /IMAGE_ESTIMATE_UNAVAILABLE/);
});
