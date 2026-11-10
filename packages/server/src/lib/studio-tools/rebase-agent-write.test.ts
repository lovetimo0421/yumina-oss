import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorldDefinition } from "@yumina/engine";
import { describeAgentWriteConflicts, rebaseAgentWrite } from "./rebase-agent-write.js";
import { executeApplyChanges } from "./tool-executor.js";

type Json = Record<string, unknown>;

function world(overrides: Json = {}): Json {
  return {
    id: "w", version: "21.0.0", name: "Card", description: "", author: "a",
    entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
    ...overrides,
  };
}
const entry = (id: string, content: string) => ({
  id, name: id, content, role: "lore", section: "chat-history", position: 0, keywords: [], conditions: [],
  conditionLogic: "all", enabled: true, alwaysSend: false,
});
const variable = (id: string, defaultValue: number) => ({ id, name: id, type: "number", defaultValue });

describe("rebaseAgentWrite", () => {
  it("keeps the creator's save and the agent's change when they touch different things", () => {
    const base = world({ entries: [entry("a", "old a"), entry("b", "old b")], variables: [variable("hp", 1)] });
    const current = world({ entries: [entry("a", "creator a"), entry("b", "old b")], variables: [variable("hp", 1)], worldbooks: [{ id: "wb", name: "Book" }] });
    const proposed = world({ entries: [entry("a", "old a"), entry("b", "agent b")], variables: [variable("hp", 1), variable("mp", 5)] });
    const { schema, conflicts } = rebaseAgentWrite(base, current, proposed);
    const entries = schema.entries as Array<{ id: string; content: string }>;
    assert.equal(entries.find(e => e.id === "a")?.content, "creator a");
    assert.equal(entries.find(e => e.id === "b")?.content, "agent b");
    assert.deepEqual((schema.variables as Array<{ id: string }>).map(v => v.id).sort(), ["hp", "mp"]);
    // A key mergeWorldDefinition does not know about still survives.
    assert.deepEqual(schema.worldbooks, [{ id: "wb", name: "Book" }]);
    assert.deepEqual(conflicts, []);
  });

  it("lets the creator win when both edited the same entity, and reports it", () => {
    const base = world({ entries: [entry("a", "old")], name: "Card" });
    const current = world({ entries: [entry("a", "creator")], name: "Creator title" });
    const proposed = world({ entries: [entry("a", "agent")], name: "Agent title" });
    const { schema, conflicts } = rebaseAgentWrite(base, current, proposed);
    assert.equal((schema.entries as Array<{ content: string }>)[0]?.content, "creator");
    assert.equal(schema.name, "Creator title");
    assert.deepEqual(conflicts.map(c => `${c.collection}:${c.id}`).sort(), ["entries:a", "field:name"]);
    const message = describeAgentWriteConflicts(conflicts);
    assert.match(message, /entries\/a/);
    assert.match(message, /\bname\b/);
    assert.match(message, /NOT saved/);
  });

  it("does not report identical edits on both sides as a conflict", () => {
    const base = world({ settings: { maxTokens: 4000, temperature: 1, playerName: "User" } });
    const same = world({ settings: { maxTokens: 8000, temperature: 1, playerName: "User" } });
    const { schema, conflicts } = rebaseAgentWrite(base, same, same);
    assert.equal((schema.settings as { maxTokens: number }).maxTokens, 8000);
    assert.deepEqual(conflicts, []);
  });

  it("merges frontend files one by one", () => {
    const rc = (files: Record<string, string>) => ({ id: "rc", name: "UI", entryFile: "index.tsx", files, updatedAt: "t" });
    const base = world({ rootComponent: rc({ "index.tsx": "i0", "panel.tsx": "p0" }) });
    const current = world({ rootComponent: rc({ "index.tsx": "i-creator", "panel.tsx": "p0" }) });
    const proposed = world({ rootComponent: rc({ "index.tsx": "i0", "panel.tsx": "p-agent" }) });
    const { schema, conflicts } = rebaseAgentWrite(base, current, proposed);
    assert.deepEqual((schema.rootComponent as { files: Record<string, string> }).files, { "index.tsx": "i-creator", "panel.tsx": "p-agent" });
    assert.deepEqual(conflicts, []);
  });
});

describe("update_settings validation", () => {
  const w = () => world() as unknown as WorldDefinition;
  const apply = (data: Json) => executeApplyChanges(w(), [{ action: "update", entityType: "settings", id: "settings", data }]);

  it("coerces numeric strings and clamps to the schema's ranges", () => {
    const result = apply({ temperature: "0.8", topP: 3, lorebookRecursionDepth: 42.4, maxTokens: "2048" });
    assert.equal(result.success, true);
    const s = result.world.settings as unknown as Json;
    assert.equal(s.temperature, 0.8);
    assert.equal(s.topP, 1);
    assert.equal(s.lorebookRecursionDepth, 10);
    assert.equal(s.maxTokens, 2048);
    assert.match(result.results[0]?.note ?? "", /topP 3 → 1/);
  });

  it("rejects garbage without changing anything", () => {
    const result = apply({ temperature: 0.5, maxTokens: "lots", playerName: 7 });
    assert.equal(result.success, false);
    assert.match(result.summary, /maxTokens must be a number/);
    assert.match(result.summary, /playerName must be a non-empty string/);
  });
});
