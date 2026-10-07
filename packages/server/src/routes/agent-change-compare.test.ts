import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorldDefinition } from "@yumina/engine";
import { buildChangeCompareFromRun } from "./agent.js";

// Run through scripts/test-local.mjs (importing the route module boots the
// isolated in-memory database).
const world = {
  id: "w", version: "21.0.0", name: "w", description: "", author: "",
  entries: [], variables: [{ id: "fav", name: "好感度", type: "number", defaultValue: 10 }],
  rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {},
} as unknown as WorldDefinition;

const call = (id: string, name: string, args: unknown) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

describe("change compare payload", () => {
  it("names the entity, not its id, and carries a structured part", () => {
    const payload = buildChangeCompareFromRun(world, [call("c1", "write_variable", { id: "fav", max: 100 })], "c1")!;
    assert.equal(payload.title, "好感度");
    assert.equal(payload.parts.length, 1);
    assert.deepEqual({ action: payload.parts[0]!.action, entityType: payload.parts[0]!.entityType, name: payload.parts[0]!.name }, { action: "update", entityType: "variable", name: "好感度" });
  });

  it("multi-change headings use names, never `delete variable <id>`", () => {
    const two = { ...world, variables: [...world.variables, { id: "a1b2", name: "金币", type: "number", defaultValue: 0 }] } as WorldDefinition;
    const payload = buildChangeCompareFromRun(two, [call("c2", "delete_entities", { ids: ["fav", "a1b2"] })], "c2")!;
    assert.ok(payload, "payload");
    assert.equal(payload.parts.length, 2);
    assert.doesNotMatch(payload.original, /### (delete|create|update) variable/);
    assert.match(payload.original, /### 好感度/);
    assert.match(payload.original, /### 金币/);
  });
});
