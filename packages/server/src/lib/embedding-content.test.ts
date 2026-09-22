import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PromptBuilder } from "@yumina/engine";
import { createHash } from "node:crypto";
import { buildWorldEmbeddingInput, buildWorldEmbeddingText } from "./embedding-content.js";

const greeting = (content: string, position?: number) => ({
  id: content, name: content, role: "greeting", enabled: true, content, position,
});

describe("published world embedding content", () => {
  it("includes enabled greeting entries in engine order, without modifying the schema", () => {
    const entries = [greeting("Last"), greeting("Second", 2), greeting("First", 1),
      greeting("Also second", 2), { ...greeting("Disabled", 0), enabled: false },
      { ...greeting("Private lore", -1), role: "system" }];
    const original = structuredClone(entries);
    const world = { name: "Published story", schema: { entries } };
    const engineOrder = new PromptBuilder().buildGreetingEntries(world.schema as never).map(e => e.content);
    const text = buildWorldEmbeddingText(world);
    assert.ok(text.includes(`Opening: ${engineOrder.join("\n\n")}`), text);
    assert.ok(!text.includes("Disabled"));
    assert.ok(!text.includes("Private lore"));
    assert.deepEqual(entries, original);
  });

  it("never lets legacy firstMessage override real or intentionally empty entries", () => {
    for (const entries of [[greeting("Live opening")], [], [{ ...greeting("Hidden"), enabled: false }]]) {
      const text = buildWorldEmbeddingText({ name: "Story", schema: { entries, firstMessage: "Stale legacy" } });
      assert.ok(!text.includes("Stale legacy"));
      assert.equal(text.includes("Live opening"), entries.length > 0 && entries[0]!.enabled);
    }
  });

  it("supports legacy schema string and array openings only when entries are absent", () => {
    for (const firstMessage of [" Legacy opening ", [" Legacy opening ", "Alternative"]]) {
      const text = buildWorldEmbeddingText({ name: "Story", schema: { firstMessage } });
      assert.ok(text.endsWith("Opening: Legacy opening"), text);
      assert.ok(!text.includes("Alternative"));
    }
  });

  it("handles empty and malformed documents without embedding unrelated fields", () => {
    for (const schema of [undefined, null, {}, [], "bad", { entries: [null, 1, {}, { role: "greeting", enabled: true, content: {} }] }]) {
      assert.equal(buildWorldEmbeddingText({ name: " Story ", schema }), "Title: Story");
    }
  });

  it("bounds the combined opening to 2000 characters and the entire input to 8000 UTF-8 bytes", () => {
    const opening = buildWorldEmbeddingText({ name: "Story", schema: { entries: [greeting("a".repeat(1990), 0), greeting("b".repeat(500), 1)] } });
    assert.ok(opening.includes("Opening: "), opening);
    assert.equal(opening.split("Opening: ")[1]!.length, 2000);
    const text = buildWorldEmbeddingText({ name: "n".repeat(10_000), description: "中".repeat(10_000),
      tags: ["t".repeat(10_000)], announcement: "a".repeat(10_000),
      schema: { entries: [greeting("Opening survives"), greeting("😀".repeat(4000))] } });
    assert.ok(Buffer.byteLength(text, "utf8") <= 8000);
    assert.ok(text.includes("Opening survives"));
    assert.ok(!text.includes("\uFFFD"));
  });

  it("identifies the exact bounded input with a deterministic version and hash", () => {
    const build = buildWorldEmbeddingInput;
    const world = { name: "Story", schema: { entries: [greeting("Opening")] } };
    const first = build(world);
    assert.deepEqual(first, build(structuredClone(world)));
    assert.equal(first.version, "published-greetings-v1");
    assert.match(first.hash, /^[a-f0-9]{64}$/);
    assert.equal(first.hash, createHash("sha256").update(`${first.version}\n${first.text}`).digest("hex"));
    assert.notEqual(first.hash, build({ ...world, name: "Other" }).hash);
    assert.notEqual(first.hash, build({ ...world, schema: { entries: [greeting("Changed")] } }).hash);
    assert.equal(first.hash, build({ ...world, schema: { ...world.schema, privateUnusedField: "Ignored" } }).hash);
  });
});
