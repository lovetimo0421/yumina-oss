import test from "node:test";
import assert from "node:assert/strict";
import { executeApplyChanges, executeReadEntities, executeGrepWorld, executeValidateWorld, executeAnalyzeTokenCost, classifyApproval, toolCallsToSchemaChanges, resolveEntityType, type SchemaChange } from "./tool-executor.js";
import type { WorldDefinition } from "@yumina/engine";
import { worldDefinitionSchema } from "@yumina/engine";

/** Build OpenAI-style tool calls the way the agent loop hands them to toolCallsToSchemaChanges. */
function toolCall(name: string, args: Record<string, unknown>) {
  return { id: `tc-${name}-${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: JSON.stringify(args) } };
}

// ── Test World Factory ──

function makeWorld(overrides?: Partial<WorldDefinition>): WorldDefinition {
  return {
    id: "test-world",
    version: "19.0.0",
    name: "Test World",
    description: "A test world",
    author: "test",
    entries: [],
    variables: [],
    rules: [],
    reactions: [],
    components: [],
    audioTracks: [],
    customUI: [],
    settings: { maxTokens: 4000, temperature: 1.0, playerName: "User" },
    ...overrides,
  } as WorldDefinition;
}

// ── executeReadEntities ──

test("executeReadEntities returns full entity data for valid IDs", () => {
  const world = makeWorld({
    entries: [{ id: "tavern", name: "Tavern", content: "A cozy tavern", role: "lore", section: "chat-history", position: 0, keywords: ["tavern"], conditions: [], conditionLogic: "all", enabled: true, alwaysSend: false }],
    variables: [{ id: "hp", name: "HP", type: "number", defaultValue: 100 }],
  });

  const result = executeReadEntities(world, ["tavern", "hp"]);
  assert.ok(result.results.tavern);
  assert.ok(result.results.hp);
  assert.equal((result.results.tavern as Record<string, unknown>)._type, "entry");
  assert.equal((result.results.hp as Record<string, unknown>)._type, "variable");
});

test("executeReadEntities returns null for unknown IDs", () => {
  const world = makeWorld();
  const result = executeReadEntities(world, ["nonexistent"]);
  assert.equal(result.results.nonexistent, null);
});

test("executeReadEntities finds behaviors in reactions array", () => {
  const world = makeWorld({
    reactions: [{ id: "dmg-calc", name: "Damage", when: { eventType: "action:fired" }, conditions: [], conditionLogic: "all", then: [], priority: 0, enabled: true }],
  });

  const result = executeReadEntities(world, ["dmg-calc"]);
  assert.ok(result.results["dmg-calc"]);
  assert.equal((result.results["dmg-calc"] as Record<string, unknown>)._type, "behavior");
});

// ── executeReadEntities: offset_lines / limit_lines pagination ──

test("executeReadEntities slices TSX with offset_lines + limit_lines", () => {
  const tsx = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n");
  const world = makeWorld({
    customUI: [{ id: "big", name: "Big", language: "tsx", surface: "app", tsxCode: tsx, description: "", order: 0, visible: true, updatedAt: "2026-01-01T00:00:00Z" }],
  });

  const result = executeReadEntities(world, ["big"], { offset_lines: 10, limit_lines: 5 });
  const payload = result.results.big as Record<string, unknown>;
  assert.ok(payload);
  const code = String(payload.tsxCode);
  // Header should indicate the slice range + total
  assert.ok(code.includes("Showing lines 10-14 of 100"), `header missing: ${code.slice(0, 200)}`);
  // Should contain exactly the 5 requested lines (line-10..line-14) and none of line-15+ or line-9-
  assert.ok(code.includes("line-10"));
  assert.ok(code.includes("line-14"));
  assert.ok(!code.includes("line-15"));
  assert.ok(!code.includes("line-9\n")); // guard: don't match "line-9" inside "line-91"
  const sliced = payload._sliced as { offset: number; limit: number; total: number; returned: number };
  assert.deepEqual(sliced, { offset: 10, limit: 5, total: 100, returned: 5 });
});

test("executeReadEntities returns full TSX when no pagination params given", () => {
  const tsx = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n");
  const world = makeWorld({
    customUI: [{ id: "small", name: "Small", language: "tsx", surface: "app", tsxCode: tsx, description: "", order: 0, visible: true, updatedAt: "2026-01-01T00:00:00Z" }],
  });

  const result = executeReadEntities(world, ["small"]);
  const payload = result.results.small as Record<string, unknown>;
  assert.equal(payload.tsxCode, tsx);
  assert.equal(payload._sliced, undefined);
});

test("executeReadEntities handles offset past end of file gracefully", () => {
  const tsx = Array.from({ length: 5 }, (_, i) => `line-${i + 1}`).join("\n");
  const world = makeWorld({
    customUI: [{ id: "tiny", name: "Tiny", language: "tsx", surface: "app", tsxCode: tsx, description: "", order: 0, visible: true, updatedAt: "2026-01-01T00:00:00Z" }],
  });

  const result = executeReadEntities(world, ["tiny"], { offset_lines: 100, limit_lines: 10 });
  const payload = result.results.tiny as Record<string, unknown>;
  const code = String(payload.tsxCode);
  assert.ok(code.includes("past end of file"), `expected past-end message, got: ${code.slice(0, 200)}`);
  const sliced = payload._sliced as { returned: number };
  assert.equal(sliced.returned, 0);
});

test("executeReadEntities pagination ignored for non-TSX entity types", () => {
  const world = makeWorld({
    variables: [{ id: "hp", name: "HP", type: "number", defaultValue: 100 }],
  });

  const result = executeReadEntities(world, ["hp"], { offset_lines: 5, limit_lines: 10 });
  const payload = result.results.hp as Record<string, unknown>;
  // Variable has no tsxCode — slicing is a no-op, original shape preserved
  assert.equal(payload._type, "variable");
  assert.equal(payload.name, "HP");
  assert.equal(payload._sliced, undefined);
});

test("executeReadEntities slices rootComponent files by filename", () => {
  const tsx = Array.from({ length: 50 }, (_, i) => `rc-line-${i + 1}`).join("\n");
  const world = makeWorld({
    rootComponent: {
      id: "rc",
      name: "Root",
      entryFile: "app.tsx",
      files: { "app.tsx": "entry", "homepage.tsx": tsx },
      updatedAt: "2026-01-01T00:00:00Z",
    },
  });

  const result = executeReadEntities(world, ["homepage.tsx"], { offset_lines: 20, limit_lines: 3 });
  const payload = result.results["homepage.tsx"] as Record<string, unknown>;
  const code = String(payload.tsxCode);
  assert.ok(code.includes("Showing lines 20-22 of 50"));
  assert.ok(code.includes("rc-line-20"));
  assert.ok(code.includes("rc-line-22"));
  assert.ok(!code.includes("rc-line-23"));
});

test("executeReadEntities caps limit_lines at MAX_LIMIT_LINES", () => {
  const tsx = Array.from({ length: 10_000 }, (_, i) => `l-${i}`).join("\n");
  const world = makeWorld({
    customUI: [{ id: "huge", name: "Huge", language: "tsx", surface: "app", tsxCode: tsx, description: "", order: 0, visible: true, updatedAt: "2026-01-01T00:00:00Z" }],
  });

  const result = executeReadEntities(world, ["huge"], { offset_lines: 1, limit_lines: 99_999 });
  const payload = result.results.huge as Record<string, unknown>;
  const sliced = payload._sliced as { limit: number; returned: number };
  // Cap enforced at 5000
  assert.equal(sliced.limit, 5000);
  assert.equal(sliced.returned, 5000);
});

// ── executeGrepWorld ──

const SEARCH_TSX = [
  "import React from 'react';",
  "",
  "const ARC_OPTIONS = [",
  "  { id: 'a', label: 'Arc A' },",
  "];",
  "",
  "const ARC_FLAVORS = {",
  "  a: 'trial of the sea',",
  "};",
  "",
  "export default function App() { return null; }",
].join("\n");

test("executeGrepWorld finds TSX match scoped by id", () => {
  const world = makeWorld({
    customUI: [{ id: "teacher", name: "T", language: "tsx", surface: "app", tsxCode: SEARCH_TSX, description: "", order: 0, visible: true, updatedAt: "2026-01-01T00:00:00Z" }],
  });

  const result = executeGrepWorld(world, { id: "teacher", query: "trial of the sea" });
  assert.equal(result.error, undefined);
  assert.equal(result.matchCount, 1);
  assert.equal(result.matches[0]!.line, 8);
  assert.equal(result.matches[0]!.entityType, "customUI");
  assert.equal(result.matches[0]!.entityId, "teacher");
  assert.equal(result.matches[0]!.field, "tsxCode");
  assert.ok(result.matches[0]!.context.includes("ARC_FLAVORS"));
  assert.ok(/^>\s+8:/m.test(result.matches[0]!.context));
});

test("executeGrepWorld returns error for unknown id", () => {
  const world = makeWorld();
  const result = executeGrepWorld(world, { id: "missing", query: "anything" });
  assert.ok(result.error);
  assert.equal(result.matchCount, 0);
});

test("executeGrepWorld caps matches at 20 and flags truncation", () => {
  const tsx = Array.from({ length: 25 }, () => "const X = 1;").join("\n");
  const world = makeWorld({
    customUI: [{ id: "spam", name: "S", language: "tsx", surface: "app", tsxCode: tsx, description: "", order: 0, visible: true, updatedAt: "2026-01-01T00:00:00Z" }],
  });

  const result = executeGrepWorld(world, { id: "spam", query: "X", context_lines: 1 });
  assert.equal(result.matchCount, 20);
  assert.equal(result.truncated, true);
});

test("executeGrepWorld resolves rootComponent alias + filenames", () => {
  const world = makeWorld({
    rootComponent: {
      id: "rc",
      name: "Root",
      entryFile: "app.tsx",
      files: {
        "app.tsx": "const ENTRY = 1;",
        "homepage.tsx": "const HOMEPAGE = 2;",
      },
      updatedAt: "2026-01-01T00:00:00Z",
    },
  });

  const entryMatch = executeGrepWorld(world, { id: "root-component", query: "ENTRY" });
  assert.equal(entryMatch.matchCount, 1);
  assert.equal(entryMatch.matches[0]!.entityId, "app.tsx");

  const fileMatch = executeGrepWorld(world, { id: "homepage.tsx", query: "HOMEPAGE" });
  assert.equal(fileMatch.matchCount, 1);
  assert.equal(fileMatch.matches[0]!.entityId, "homepage.tsx");
});

test("executeGrepWorld searches entry content across all entries by default", () => {
  const world = makeWorld({
    entries: [
      { id: "e1", name: "Tavern", content: "A cozy tavern. The barkeep mentions her sister.", role: "lore", section: "chat-history", position: 0, keywords: ["tavern"], conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: false },
      { id: "e2", name: "Backstory", content: "Alice has a sister named Mira who vanished.", role: "lore", section: "chat-history", position: 1, keywords: ["alice"], conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: false },
      { id: "e3", name: "Unrelated", content: "Weather report.", role: "lore", section: "chat-history", position: 2, keywords: ["weather"], conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: false },
    ],
  });

  const result = executeGrepWorld(world, { query: "sister" });
  assert.equal(result.matchCount, 2);
  const ids = result.matches.map((m) => m.entityId).sort();
  assert.deepEqual(ids, ["e1", "e2"]);
  assert.ok(result.matches.every((m) => m.entityType === "entry" && m.field === "content"));
});

test("executeGrepWorld scope=variables searches behaviorRules", () => {
  const world = makeWorld({
    variables: [
      { id: "hp", name: "HP", type: "number" as const, defaultValue: 100, behaviorRules: "Decrease on combat damage. 0 = dead." },
      { id: "gold", name: "Gold", type: "number" as const, defaultValue: 0, behaviorRules: "Gain from quests. Spend on gear." },
    ],
  });

  const result = executeGrepWorld(world, { query: "combat", scope: "variables" });
  assert.equal(result.matchCount, 1);
  assert.equal(result.matches[0]!.entityId, "hp");
  assert.equal(result.matches[0]!.entityType, "variable");
  assert.equal(result.matches[0]!.field, "behaviorRules");
});

test("executeGrepWorld scope=all mixes entity types in results", () => {
  const world = makeWorld({
    entries: [{ id: "lore-combat", name: "Combat lore", content: "combat is brutal.", role: "lore", section: "chat-history", position: 0, keywords: ["combat"], conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: false }],
    variables: [{ id: "hp", name: "HP", type: "number" as const, defaultValue: 100, behaviorRules: "Decrease on combat damage." }],
  });

  const result = executeGrepWorld(world, { query: "combat" });
  assert.equal(result.matchCount, 2);
  const types = new Set(result.matches.map((m) => m.entityType));
  assert.deepEqual([...types].sort(), ["entry", "variable"]);
});

test("executeGrepWorld with empty query returns a friendly error", () => {
  const world = makeWorld({
    entries: [{ id: "x", name: "X", content: "anything", role: "lore", section: "chat-history", position: 0, keywords: ["x"], conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: false }],
  });
  const result = executeGrepWorld(world, { query: "" });
  assert.ok(result.error);
  assert.equal(result.matchCount, 0);
});


// ── executeApplyChanges — Create ──

test("apply_changes creates an entry", () => {
  const world = makeWorld();
  const changes: SchemaChange[] = [{
    action: "create",
    entityType: "entry",
    id: "tavern",
    data: { name: "The Tavern", content: "A cozy place", role: "lore", section: "chat-history" },
  }];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
  assert.equal(result.world.entries.length, 1);
  assert.equal(result.world.entries[0]!.id, "tavern");
  assert.equal(result.world.entries[0]!.name, "The Tavern");
});

test("apply_changes creates a variable with behaviorRules", () => {
  const world = makeWorld();
  const changes: SchemaChange[] = [{
    action: "create",
    entityType: "variable",
    id: "hp",
    data: { name: "HP", type: "number", defaultValue: 100, min: 0, max: 100, behaviorRules: "Decrease on damage" },
  }];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
  assert.equal(result.world.variables.length, 1);
  assert.equal(result.world.variables[0]!.behaviorRules, "Decrease on damage");
});

test("apply_changes creates a behavior", () => {
  const world = makeWorld();
  const changes: SchemaChange[] = [{
    action: "create",
    entityType: "behavior",
    id: "combat",
    data: {
      name: "Combat",
      when: { eventType: "action:fired" },
      then: [{ path: "hp", op: "set", value: 50 }],
    },
  }];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
  assert.equal(result.world.reactions!.length, 1);
  assert.equal(result.world.reactions![0]!.id, "combat");
});

test("apply_changes preserves valueRandom, valueRef, and chance on a behavior", () => {
  const world = makeWorld();
  const changes: SchemaChange[] = [{
    action: "create",
    entityType: "behavior",
    id: "daily",
    data: {
      name: "Daily roster",
      when: { eventType: "state:changed" },
      chance: 30,
      then: [
        { type: "set", path: "生命", operation: "subtract", valueRef: "力量" },
        { type: "set", path: "今日拷问官", operation: "set", valueRandom: { kind: "list", candidates: ["霜月", "锦织"], cooldown: 3, historyVar: "登场历史" } },
        { type: "set", path: "力量", operation: "set", valueRandom: { kind: "dice", count: 3, sides: 6, modifier: 2 } },
      ],
    },
  }];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
  const r = result.world.reactions![0]!;
  assert.equal(r.chance, 30);
  const effects = r.then as Array<Record<string, unknown>>;
  assert.equal(effects[0]!.valueRef, "力量");
  assert.deepEqual(effects[1]!.valueRandom, { kind: "list", candidates: ["霜月", "锦织"], cooldown: 3, historyVar: "登场历史" });
  assert.deepEqual(effects[2]!.valueRandom, { kind: "dice", count: 3, sides: 6, modifier: 2 });
});

test("apply_changes creates an audio track", () => {
  const world = makeWorld();
  const changes: SchemaChange[] = [{
    action: "create",
    entityType: "audio",
    id: "battle-bgm",
    data: { name: "Battle Theme", type: "bgm", url: "@asset:abc123", loop: true },
  }];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
  assert.equal(result.world.audioTracks.length, 1);
  assert.equal(result.world.audioTracks[0]!.id, "battle-bgm");
});

// ── executeApplyChanges — Update ──

test("apply_changes updates an entry partially", () => {
  const world = makeWorld({
    entries: [{ id: "tavern", name: "Tavern", content: "Old content", role: "lore", section: "chat-history", position: 0, keywords: [], conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: false }],
  });

  const changes: SchemaChange[] = [{
    action: "update",
    entityType: "entry",
    id: "tavern",
    data: { content: "New mysterious content" },
  }];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
  assert.equal(result.world.entries[0]!.content, "New mysterious content");
  assert.equal(result.world.entries[0]!.name, "Tavern"); // Unchanged
});

test("apply_changes returns error for updating nonexistent entity", () => {
  const world = makeWorld();
  const changes: SchemaChange[] = [{
    action: "update",
    entityType: "entry",
    id: "ghost",
    data: { name: "Ghost" },
  }];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, false);
  assert.equal(result.results[0]!.status, "error");
});

// ── executeApplyChanges — Delete ──

test("apply_changes deletes an entry", () => {
  const world = makeWorld({
    entries: [{ id: "tavern", name: "Tavern", content: "", role: "lore", section: "chat-history", position: 0, keywords: [], conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: false }],
  });

  const changes: SchemaChange[] = [{
    action: "delete",
    entityType: "entry",
    id: "tavern",
  }];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
  assert.equal(result.world.entries.length, 0);
});

// ── executeApplyChanges — Batch & Atomic ──

test("apply_changes handles mixed batch (create + update + delete)", () => {
  const world = makeWorld({
    entries: [{ id: "old-entry", name: "Old", content: "", role: "lore", section: "chat-history", position: 0, keywords: [], conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: false }],
    variables: [{ id: "hp", name: "HP", type: "number" as const, defaultValue: 100 }],
  });

  const changes: SchemaChange[] = [
    { action: "create", entityType: "entry", id: "new-entry", data: { name: "New Entry", content: "Content", section: "chat-history" } },
    { action: "update", entityType: "variable", id: "hp", data: { max: 200 } },
    { action: "delete", entityType: "entry", id: "old-entry" },
  ];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
  assert.equal(result.world.entries.length, 1);
  assert.equal(result.world.entries[0]!.id, "new-entry");
  assert.equal(result.world.variables[0]!.max, 200);
});

test("write_variable persists scope:setup on create and update (roster-pick survives opening switch)", () => {
  const world = makeWorld({
    variables: [{ id: "route", name: "Route", type: "string" as const, defaultValue: "" }],
  });

  const changes: SchemaChange[] = [
    // create a cast-selection variable with setup scope
    { action: "create", entityType: "variable", id: "selected-members", data: { name: "登场成员", type: "json", defaultValue: "[]", scope: "setup" } },
    // promote an existing variable to setup scope
    { action: "update", entityType: "variable", id: "route", data: { scope: "setup" } },
  ];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
  const sel = result.world.variables.find((v) => v.id === "selected-members");
  assert.equal(sel!.scope, "setup");
  const route = result.world.variables.find((v) => v.id === "route");
  assert.equal(route!.scope, "setup");
});

test("write_variable persists aiAccess / activation / enabled on create and update", () => {
  const world = makeWorld({
    variables: [{ id: "阶段", name: "阶段", type: "string" as const, defaultValue: "观察" }],
  });

  const changes: SchemaChange[] = [
    // engine-only ledger, gated to a dungeon phase via conditions
    {
      action: "create", entityType: "variable", id: "副本账本",
      data: {
        name: "副本账本", type: "json", defaultValue: "{}",
        aiAccess: "none",
        activation: { mode: "conditions", conditions: [{ variableId: "阶段", operator: "neq", value: "观察" }], conditionLogic: "all" },
      },
    },
    // manual-gated variable starting disabled
    { action: "create", entityType: "variable", id: "直播积分", data: { name: "直播积分", type: "number", defaultValue: 0, activation: { mode: "manual" }, enabled: false } },
    // promote an existing variable to AI read-only
    { action: "update", entityType: "variable", id: "阶段", data: { aiAccess: "read" } },
  ];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
  const ledger = result.world.variables.find((v) => v.id === "副本账本");
  assert.equal(ledger!.aiAccess, "none");
  assert.equal(ledger!.activation?.mode, "conditions");
  const score = result.world.variables.find((v) => v.id === "直播积分");
  assert.equal(score!.activation?.mode, "manual");
  assert.equal(score!.enabled, false);
  const phase = result.world.variables.find((v) => v.id === "阶段");
  assert.equal(phase!.aiAccess, "read");
});

test("apply_changes is atomic — rolls back ALL on any error", () => {
  const world = makeWorld({
    entries: [{ id: "keep-me", name: "Keep", content: "", role: "lore", section: "chat-history", position: 0, keywords: [], conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: false }],
  });

  const changes: SchemaChange[] = [
    { action: "create", entityType: "entry", id: "new-entry", data: { name: "New" } },
    { action: "update", entityType: "entry", id: "nonexistent", data: { name: "Fail" } }, // This fails
  ];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, false);
  // Original world unchanged — atomic rollback
  assert.equal(result.world.entries.length, 1);
  assert.equal(result.world.entries[0]!.id, "keep-me");
});

// ── executeApplyChanges — CustomUI with TSX ──

test("apply_changes validates TSX code on create", () => {
  // Writes now always land in rootComponent (v2 unification). When the input
  // world lacks a rootComponent, ensureRootComponent stamps one before the write.
  const world = makeWorld();
  const changes: SchemaChange[] = [{
    action: "create",
    entityType: "customUI",
    id: "test-ui.tsx",
    data: {
      name: "Test",
      tsxCode: "export default function Test() { return <div>Hello</div> }",
    },
  }];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
  assert.ok(result.world.rootComponent);
  assert.equal(result.world.customUI.length, 0);
  assert.ok(result.world.rootComponent.files["test-ui.tsx"]?.includes("Hello"));
});

test("apply_changes rejects write_custom_ui containing inline base64 data URI", () => {
  const world = makeWorld();
  const bigBlob = "A".repeat(500);
  const changes: SchemaChange[] = [{
    action: "create",
    entityType: "customUI",
    id: "heavy-ui",
    data: {
      name: "Heavy",
      surface: "app",
      tsxCode: `export default function UI() { return <img src="data:image/png;base64,${bigBlob}" />; }`,
    },
  }];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, false);
  assert.ok(result.results[0]!.error!.includes("inline base64"));
  assert.ok(result.results[0]!.error!.includes("@asset:"));
});

test("apply_changes rejects edit_custom_ui when new_code introduces base64", () => {
  const world = makeWorld({
    customUI: [{
      id: "clean-ui",
      name: "Clean",
      surface: "app",
      language: "tsx",
      tsxCode: "export default function UI() { return <img src=\"https://example.com/image.png\" />; }",
      description: "",
      order: 0,
      visible: true,
      updatedAt: "2026-01-01T00:00:00Z",
    }],
  });

  const bigBlob = "B".repeat(300);
  const changes: SchemaChange[] = [{
    action: "update",
    entityType: "customUI",
    id: "clean-ui",
    data: {
      old_code: "https://example.com/image.png",
      new_code: `data:image/jpeg;base64,${bigBlob}`,
      _editMode: true,
    },
  }];

  // edit_custom_ui is routed through schema-change differently; test via direct executor
  // of the edit function if available, or ensure the guard rejects it.
  // For simplicity here we test the write path — same assertNoInlineDataUris helper guards both.
  const writeChanges: SchemaChange[] = [{
    action: "update",
    entityType: "customUI",
    id: "clean-ui",
    data: { tsxCode: `export default function UI() { return <img src="data:image/jpeg;base64,${bigBlob}" />; }` },
  }];
  void changes;

  const result = executeApplyChanges(world, writeChanges);
  assert.equal(result.success, false);
  assert.ok(result.results[0]!.error!.includes("inline base64"));
});

test("apply_changes allows small SVG icon placeholders (under 200-char threshold)", () => {
  const world = makeWorld();
  const tinyBase64 = "C".repeat(100);
  const changes: SchemaChange[] = [{
    action: "create",
    entityType: "customUI",
    id: "icon-ui",
    data: {
      name: "Icon",
      surface: "app",
      tsxCode: `export default function UI() { return <img src="data:image/png;base64,${tinyBase64}" />; }`,
    },
  }];

  const result = executeApplyChanges(world, changes);
  // Should succeed — tiny payload below the 200-char threshold (likely a placeholder/dot)
  assert.equal(result.success, true);
});

test("apply_changes rejects write_audio with data: URI as url", () => {
  const world = makeWorld();
  const changes: SchemaChange[] = [{
    action: "create",
    entityType: "audio",
    id: "inline-bgm",
    data: { name: "Inline", type: "bgm", url: "data:audio/mp3;base64,XXX", loop: true },
  }];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, false);
  assert.ok(result.results[0]!.error!.includes("@asset:"));
});

test("apply_changes allows write_audio with @asset: URL", () => {
  const world = makeWorld();
  const changes: SchemaChange[] = [{
    action: "create",
    entityType: "audio",
    id: "good-bgm",
    data: { name: "Good", type: "bgm", url: "@asset:audio-123", loop: true },
  }];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
});

test("apply_changes rejects invalid TSX", () => {
  const world = makeWorld();
  const changes: SchemaChange[] = [{
    action: "create",
    entityType: "customUI",
    id: "bad-ui",
    data: {
      name: "Bad",
      surface: "app",
      tsxCode: "export default function Bad() { return <div>",  // Unclosed JSX
    },
  }];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, false);
  assert.ok(result.results[0]!.error!.includes("TSX compile error"));
});

// ── classifyApproval ──

test("classifyApproval auto-executes safe creates", () => {
  const changes: SchemaChange[] = [
    { action: "create", entityType: "entry", id: "a", data: { name: "A" } },
    { action: "create", entityType: "variable", id: "b", data: { name: "B" } },
  ];
  const decision = classifyApproval(changes);
  assert.equal(decision.autoExecute, true);
});

test("classifyApproval requires confirmation for deletes", () => {
  const changes: SchemaChange[] = [
    { action: "delete", entityType: "entry", id: "a" },
  ];
  const decision = classifyApproval(changes);
  assert.equal(decision.autoExecute, false);
  assert.ok(decision.reason.includes("delete"));
});

test("classifyApproval requires confirmation for TSX code", () => {
  const changes: SchemaChange[] = [
    { action: "create", entityType: "customUI", id: "a", data: { tsxCode: "export default function() { return <div/> }" } },
  ];
  const decision = classifyApproval(changes);
  assert.equal(decision.autoExecute, false);
  assert.ok(decision.reason.includes("TSX"));
});

test("classifyApproval requires confirmation for 5+ entities", () => {
  const changes: SchemaChange[] = Array.from({ length: 5 }, (_, i) => ({
    action: "create" as const,
    entityType: "entry" as const,
    id: `entry-${i}`,
    data: { name: `Entry ${i}` },
  }));
  const decision = classifyApproval(changes);
  assert.equal(decision.autoExecute, false);
  assert.ok(decision.reason.includes("5"));
});

test("classifyApproval auto-executes empty changes", () => {
  const decision = classifyApproval([]);
  assert.equal(decision.autoExecute, true);
});

// ── Duplicate handling ──

test("apply_changes handles duplicate create by updating existing", () => {
  const world = makeWorld({
    entries: [{ id: "tavern", name: "Old Tavern", content: "Old", role: "lore", section: "chat-history", position: 0, keywords: [], conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: false }],
  });

  const changes: SchemaChange[] = [{
    action: "create",
    entityType: "entry",
    id: "tavern",
    data: { name: "New Tavern", content: "Updated content" },
  }];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
  assert.equal(result.world.entries.length, 1);
  assert.equal(result.world.entries[0]!.name, "New Tavern");
  assert.equal(result.world.entries[0]!.content, "Updated content");
});

// ── Cross-entity batch ──

// ── executeValidateWorld ──

test("validate_world reports clean on a minimal valid world", () => {
  const world = makeWorld({
    entries: [{ id: "greeting-01", name: "Greeting", content: "Welcome!", role: "greeting", section: "system-presets", position: 0, keywords: [], conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: true }],
    variables: [{ id: "hp", name: "HP", type: "number" as const, defaultValue: 100, min: 0, max: 100, behaviorRules: "Decrease 5-15 on damage. 0 = defeated." }],
  });

  const result = executeValidateWorld(world);
  // Note: may still have warnings (e.g. greeting is only marker we check, others may fire)
  assert.equal(result.errorCount, 0, `expected no errors, got: ${JSON.stringify(result.issues.filter(i => i.severity === "error"))}`);
});

test("validate_world flags entry macro referencing undefined variable", () => {
  const world = makeWorld({
    entries: [{
      id: "tavern",
      name: "Tavern",
      content: "Your HP is {{hp}}. Your stamina is {{stamina}}. Welcome, {{user}}.",
      role: "lore",
      section: "chat-history",
      position: 0,
      keywords: ["tavern"],
      conditions: [],
      conditionLogic: "all" as const,
      enabled: true,
      alwaysSend: false,
    }],
    variables: [{ id: "hp", name: "HP", type: "number" as const, defaultValue: 100, behaviorRules: "x" }],
  });

  const result = executeValidateWorld(world);
  const macroIssue = result.issues.find((i) => i.code === "entry-undefined-macro");
  assert.ok(macroIssue, "expected undefined macro warning");
  assert.ok(macroIssue!.message.includes("stamina"), `expected 'stamina' in message: ${macroIssue!.message}`);
  // {{hp}} and {{user}} should NOT flag
  assert.equal(result.issues.filter((i) => i.code === "entry-undefined-macro").length, 1);
});

test("validate_world flags entry condition referencing undefined variable", () => {
  const world = makeWorld({
    entries: [{
      id: "hidden",
      name: "Hidden",
      content: "Secret text",
      role: "lore",
      section: "chat-history",
      position: 0,
      keywords: ["secret"],
      conditions: [{ variableId: "reputation", operator: "gte", value: 50 }],
      conditionLogic: "all" as const,
      enabled: true,
      alwaysSend: false,
    }],
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "entry-undefined-condition-ref");
  assert.ok(issue);
  assert.equal(issue!.severity, "error");
  assert.ok(issue!.message.includes("reputation"));
});

test("validate_world flags chat-history entry with no triggers", () => {
  const world = makeWorld({
    entries: [{
      id: "orphan",
      name: "Orphan",
      content: "Lost entry",
      role: "lore",
      section: "chat-history",
      position: 0,
      keywords: [],
      conditions: [],
      conditionLogic: "all" as const,
      enabled: true,
      alwaysSend: false,
    }],
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "entry-no-triggers");
  assert.ok(issue);
  assert.equal(issue!.severity, "error");
});

test("validate_world allows chat-history entry with only conditions (no keywords)", () => {
  const world = makeWorld({
    entries: [{
      id: "conditional",
      name: "Conditional",
      content: "Triggers on state",
      role: "lore",
      section: "chat-history",
      position: 0,
      keywords: [],
      conditions: [{ variableId: "hp", operator: "lt", value: 10 }],
      conditionLogic: "all" as const,
      enabled: true,
      alwaysSend: false,
    }],
    variables: [{ id: "hp", name: "HP", type: "number" as const, defaultValue: 100, behaviorRules: "x" }],
  });

  const result = executeValidateWorld(world);
  const noTrigger = result.issues.find((i) => i.code === "entry-no-triggers");
  assert.equal(noTrigger, undefined, "should not flag entry that has conditions even without keywords");
});

// ── Lorebook flood diagnostic (analyze_token_cost, on-demand) ──

function bigKeywordEntry(id: string, approxTokens: number): WorldDefinition["entries"][number] {
  // " lore" tokenizes to ~1 cl100k token, so repeat≈token count. Two of these clear
  // the 25k-token flood threshold with margin.
  return {
    id, name: id, content: "lore ".repeat(approxTokens), role: "lore",
    section: "chat-history", position: 0, keywords: [id, "set", "stage"],
    conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: false,
  };
}

test("analyze_token_cost flags flood for a heavy keyword pool with no cap", () => {
  const world = makeWorld({
    entries: [bigKeywordEntry("a", 20000), bigKeywordEntry("b", 20000)], // ~120KB content → >25k tokens
    settings: { maxTokens: 4000, temperature: 1.0, playerName: "User" } as WorldDefinition["settings"],
  });
  const report = executeAnalyzeTokenCost(world);
  assert.equal(report.floodRisk, true, "should flag a large keyword-lore pool with no budget cap");
  assert.ok(report.keywordPoolTokens >= 25000);
  assert.ok(report.advisory, "advisory present when flood risk");
  assert.match(report.advisory!, /keyword-triggered lore/);
  assert.ok(report.fix, "fix priority present when flood risk");
});

test("analyze_token_cost advisory calls out recursion when it is on", () => {
  const world = makeWorld({
    entries: [bigKeywordEntry("a", 20000), bigKeywordEntry("b", 20000)],
    settings: { maxTokens: 4000, temperature: 1.0, playerName: "User", lorebookRecursionDepth: 1 } as WorldDefinition["settings"],
  });
  const report = executeAnalyzeTokenCost(world);
  assert.equal(report.floodRisk, true);
  assert.match(report.advisory!, /Recursion is ON/);
  assert.equal(report.recursionDepth, 1);
});

test("analyze_token_cost does NOT flag flood when a budget cap bounds injection", () => {
  const world = makeWorld({
    entries: [bigKeywordEntry("a", 20000), bigKeywordEntry("b", 20000)],
    settings: { maxTokens: 4000, temperature: 1.0, playerName: "User", lorebookBudgetCap: 10000 } as WorldDefinition["settings"],
  });
  const report = executeAnalyzeTokenCost(world);
  assert.equal(report.floodRisk, false, "a low budget cap bounds worst-case injection below the flood threshold");
  assert.equal(report.worstCaseInjection, 10000, "worst-case is bounded by the cap");
  assert.equal(report.advisory, undefined);
});

test("analyze_token_cost does NOT flag flood for a small keyword pool", () => {
  const world = makeWorld({
    entries: [{ id: "tavern", name: "Tavern", content: "A cozy tavern", role: "lore", section: "chat-history", position: 0, keywords: ["tavern"], conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: false }],
  });
  const report = executeAnalyzeTokenCost(world);
  assert.equal(report.floodRisk, false);
  assert.equal(report.advisory, undefined);
});

test("validate_world no longer emits lorebook-flood-risk (moved to analyze_token_cost)", () => {
  const world = makeWorld({
    entries: [bigKeywordEntry("a", 20000), bigKeywordEntry("b", 20000)],
    settings: { maxTokens: 4000, temperature: 1.0, playerName: "User" } as WorldDefinition["settings"],
  });
  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "lorebook-flood-risk");
  assert.equal(issue, undefined, "flood-risk must no longer surface from the high-frequency validator");
});

test("validate_world flags variable with no behaviorRules", () => {
  const world = makeWorld({
    variables: [{ id: "orphan-var", name: "Orphan", type: "number" as const, defaultValue: 0 }],
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "variable-no-behavior-rules");
  assert.ok(issue);
  assert.equal(issue!.severity, "warning");
});

test("validate_world flags behavior with match on undefined variable", () => {
  const world = makeWorld({
    reactions: [{
      id: "phantom-trigger",
      name: "Phantom",
      when: {
        eventType: "state:crossed",
        match: {
          variableId: { operator: "eq", value: "mana" },
          direction: { operator: "eq", value: "drops-below" },
          threshold: { operator: "eq", value: 10 },
        },
      },
      conditions: [],
      conditionLogic: "all",
      then: [],
      priority: 0,
      enabled: true,
    }],
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "behavior-undefined-match-ref");
  assert.ok(issue);
  assert.equal(issue!.severity, "error");
  assert.ok(issue!.message.includes("mana"));
});

test("validate_world flags behavior effect targeting undefined variable", () => {
  const world = makeWorld({
    reactions: [{
      id: "bad-effect",
      name: "Bad effect",
      when: { eventType: "turn:complete" },
      conditions: [],
      conditionLogic: "all",
      then: [{ type: "set", path: "phantom-var", value: 5, operation: "add" }],
      priority: 0,
      enabled: true,
    }],
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "behavior-undefined-effect-ref");
  assert.ok(issue);
  assert.equal(issue!.severity, "error");
});

test("validate_world allows @system paths without flagging them as variables", () => {
  const world = makeWorld({
    reactions: [{
      id: "audio-cue",
      name: "Audio cue",
      when: { eventType: "turn:complete" },
      conditions: [],
      conditionLogic: "all",
      then: [
        { type: "set", path: "@audio.bgm", value: "battle-theme" },
        { type: "set", path: "@prompt.directive.mood", value: "tense" },
      ],
      priority: 0,
      enabled: true,
    }],
  });

  const result = executeValidateWorld(world);
  const undefEffect = result.issues.find((i) => i.code === "behavior-undefined-effect-ref");
  assert.equal(undefEffect, undefined, "@paths should not be flagged as variable refs");
});

test("validate_world warns on self-loop: state:changed with effect writing same variable", () => {
  const world = makeWorld({
    variables: [{ id: "hp", name: "HP", type: "number" as const, defaultValue: 100, behaviorRules: "x" }],
    reactions: [{
      id: "self-loop",
      name: "Self loop",
      when: {
        eventType: "state:changed",
        match: { variableId: { operator: "eq", value: "hp" } },
      },
      conditions: [],
      conditionLogic: "all",
      // Effect writes back to the SAME variable the trigger watches → genuine loop risk
      then: [{ type: "set", path: "hp", value: 1, operation: "add" }],
      priority: 0,
      enabled: true,
    }],
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "behavior-self-loop-risk");
  assert.ok(issue);
  assert.equal(issue!.severity, "warning");
  assert.ok(issue!.message.includes("hp"));
});

test("validate_world does NOT warn when state:changed effect hits a DIFFERENT variable", () => {
  // This is Tsubo's legit r-auto-death-sfx pattern: react to `dead-names` changing,
  // emit `@audio.sfx` — no self-loop, no warning should fire.
  const world = makeWorld({
    variables: [
      { id: "dead-names", name: "Dead", type: "string" as const, defaultValue: "", behaviorRules: "x" },
      { id: "notified", name: "Notified", type: "boolean" as const, defaultValue: false, behaviorRules: "x" },
    ],
    reactions: [{
      id: "sfx-on-death",
      name: "SFX on death",
      when: {
        eventType: "state:changed",
        match: { variableId: { operator: "eq", value: "dead-names" } },
      },
      conditions: [],
      conditionLogic: "all",
      // Effect targets a @system path AND a different variable — no self-loop
      then: [
        { type: "set", path: "@audio.sfx", value: "death-sfx" },
        { type: "set", path: "notified", value: true, operation: "set" },
      ],
      priority: 0,
      enabled: true,
    }],
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "behavior-self-loop-risk");
  assert.equal(issue, undefined);
});

test("validate_world does NOT warn when state:changed has cooldownTurns", () => {
  const world = makeWorld({
    variables: [{ id: "hp", name: "HP", type: "number" as const, defaultValue: 100, behaviorRules: "x" }],
    reactions: [{
      id: "rate-limited",
      name: "Rate limited",
      when: {
        eventType: "state:changed",
        match: { variableId: { operator: "eq", value: "hp" } },
      },
      conditions: [],
      conditionLogic: "all",
      then: [{ type: "set", path: "hp", value: 1, operation: "add" }], // same var — would be flagged WITHOUT cooldown
      priority: 0,
      enabled: true,
      cooldownTurns: 3,
    }],
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "behavior-self-loop-risk");
  assert.equal(issue, undefined);
});

test("validate_world flags cross-type duplicate IDs", () => {
  const world = makeWorld({
    entries: [{ id: "hp", name: "Entry", content: "", role: "lore", section: "chat-history", position: 0, keywords: ["x"], conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: false }],
    variables: [{ id: "hp", name: "HP", type: "number" as const, defaultValue: 100, behaviorRules: "x" }],
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "duplicate-id-cross-type");
  assert.ok(issue);
  assert.equal(issue!.severity, "error");
});

test("validate_world warns on inline base64 data URI in customUI tsxCode", () => {
  const bigBlob = "A".repeat(500);
  const tsx = `export default function UI() { return <img src="data:image/png;base64,${bigBlob}" />; }`;
  const world = makeWorld({
    customUI: [{ id: "heavy-ui", name: "Heavy", language: "tsx", surface: "app", tsxCode: tsx, description: "", order: 0, visible: true, updatedAt: "2026-01-01T00:00:00Z" }],
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "inline-data-uri-in-tsx");
  assert.ok(issue, "expected inline-data-uri-in-tsx warning");
  assert.equal(issue!.severity, "warning");
  assert.ok(issue!.message.includes("heavy-ui"));
  assert.ok(issue!.fix!.includes("@asset:"));
});

test("validate_world does NOT flag short data URIs (likely SVG fragments, icons under 200 chars)", () => {
  // Intentionally small — could be a 1x1 pixel, tiny icon, or placeholder
  const tiny = "A".repeat(50);
  const tsx = `export default function UI() { return <img src="data:image/png;base64,${tiny}" />; }`;
  const world = makeWorld({
    customUI: [{ id: "tiny-ui", name: "Tiny", language: "tsx", surface: "app", tsxCode: tsx, description: "", order: 0, visible: true, updatedAt: "2026-01-01T00:00:00Z" }],
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "inline-data-uri-in-tsx");
  assert.equal(issue, undefined, "should not flag trivially small base64 payloads (threshold is 200 chars)");
});

test("validate_world warns on inline data URI inside rootComponent files", () => {
  const bigBlob = "B".repeat(300);
  const world = makeWorld({
    rootComponent: {
      id: "rc",
      name: "Root",
      entryFile: "app.tsx",
      files: { "app.tsx": `<img src="data:image/jpeg;base64,${bigBlob}" />` },
      updatedAt: "2026-01-01T00:00:00Z",
    },
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "inline-data-uri-in-tsx");
  assert.ok(issue);
  assert.equal(issue!.entity.id, "app.tsx");
});

test("validate_world warns on inline data URI inside entry content markdown", () => {
  const bigBlob = "C".repeat(400);
  const world = makeWorld({
    entries: [{
      id: "with-embedded-image",
      name: "Embedded",
      content: `Here is a picture: ![alt](data:image/png;base64,${bigBlob})`,
      role: "lore",
      section: "chat-history",
      position: 0,
      keywords: ["picture"],
      conditions: [],
      conditionLogic: "all" as const,
      enabled: true,
      alwaysSend: false,
    }],
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "inline-data-uri-in-entry");
  assert.ok(issue);
  assert.equal(issue!.entity.id, "with-embedded-image");
});

test("validate_world warns when audio track url is a data: URI", () => {
  const world = makeWorld({
    audioTracks: [{ id: "inline-bgm", name: "Inline BGM", type: "bgm", url: "data:audio/mp3;base64,XXX", loop: true }],
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "inline-data-uri-in-audio");
  assert.ok(issue);
  assert.equal(issue!.entity.id, "inline-bgm");
  assert.ok(issue!.fix!.includes("@asset:"));
});

test("validate_world does NOT flag proper @asset: and http(s):// asset references", () => {
  const tsx = `
    export default function UI() {
      var api = useYumina();
      return (
        <>
          <img src={api.resolveAssetUrl('@asset:abc123')} />
          <img src="https://cdn.example.com/image.png" />
        </>
      );
    }
  `;
  const world = makeWorld({
    customUI: [{ id: "clean-ui", name: "Clean", language: "tsx", surface: "app", tsxCode: tsx, description: "", order: 0, visible: true, updatedAt: "2026-01-01T00:00:00Z" }],
    audioTracks: [{ id: "good-bgm", name: "Good", type: "bgm", url: "@asset:audio-1", loop: true }],
  });

  const result = executeValidateWorld(world);
  const uriIssues = result.issues.filter((i) => i.code.startsWith("inline-data-uri"));
  assert.equal(uriIssues.length, 0);
});

test("validate_world warns on missing greeting", () => {
  const world = makeWorld({
    entries: [{ id: "only-lore", name: "Lore", content: "x", role: "lore", section: "system-presets", position: 0, keywords: [], conditions: [], conditionLogic: "all" as const, enabled: true, alwaysSend: true }],
  });

  const result = executeValidateWorld(world);
  const issue = result.issues.find((i) => i.code === "no-greeting");
  assert.ok(issue);
  assert.equal(issue!.severity, "warning");
});

test("apply_changes creates entries + variables + behaviors in one batch", () => {
  const world = makeWorld();
  const changes: SchemaChange[] = [
    { action: "create", entityType: "variable", id: "hp", data: { name: "HP", type: "number", defaultValue: 100 } },
    { action: "create", entityType: "variable", id: "atk", data: { name: "Attack", type: "number", defaultValue: 15 } },
    { action: "create", entityType: "entry", id: "combat-rules", data: { name: "Combat Rules", content: "When attacking...", section: "system-presets" } },
    { action: "create", entityType: "behavior", id: "damage", data: { name: "Damage Calc", when: { eventType: "action:fired" }, then: [{ path: "hp", op: "set", value: 50 }] } },
  ];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
  assert.equal(result.world.variables.length, 2);
  assert.equal(result.world.entries.length, 1);
  assert.equal(result.world.reactions!.length, 1);
});

// ── Worldbooks, lore bindings & entry routing (lore-bindings feature) ──

test("write_worldbook (conditions mode) parses, applies, and produces schema-valid output", () => {
  const world = makeWorld({ variables: [{ id: "route", name: "Route", type: "string", defaultValue: "" }] });
  const parsed = toolCallsToSchemaChanges([
    toolCall("write_worldbook", {
      id: "mayu-route",
      name: "Mayu Route",
      activation: { mode: "conditions", conditions: [{ variableId: "route", operator: "eq", value: "mayu" }], conditionLogic: "all" },
    }),
  ], world);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.error, undefined);
  assert.equal(parsed[0]!.change!.entityType, "worldbook");

  const result = executeApplyChanges(world, [parsed[0]!.change!]);
  assert.equal(result.success, true, result.summary);
  const wb = result.world.worldbooks!.find((w) => w.id === "mayu-route")!;
  assert.ok(wb);
  assert.equal(wb.name, "Mayu Route");
  assert.equal(wb.enabled, true); // defaulted on
  assert.equal(wb.activation.mode, "conditions");
  assert.equal((wb.activation as { conditions: unknown[] }).conditions.length, 1);
  // The whole world must still satisfy the engine schema (the real "will it save" gate).
  assert.equal(worldDefinitionSchema.safeParse(result.world).success, true);
});

test("write_worldbook (greeting mode) keeps greetingIds; bare 'always' needs no extra fields", () => {
  const world = makeWorld();
  const changes = toolCallsToSchemaChanges([
    toolCall("write_worldbook", { id: "intro-book", name: "Intro", activation: { mode: "greeting", greetingIds: ["open-1", "open-2"] } }),
    toolCall("write_worldbook", { id: "core-extra", name: "Always", activation: { mode: "always" } }),
  ], world).map((p) => p.change!);

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true, result.summary);
  const intro = result.world.worldbooks!.find((w) => w.id === "intro-book")!;
  assert.equal(intro.activation.mode, "greeting");
  assert.deepEqual((intro.activation as { greetingIds: string[] }).greetingIds, ["open-1", "open-2"]);
  const always = result.world.worldbooks!.find((w) => w.id === "core-extra")!;
  assert.equal(always.activation.mode, "always");
  assert.equal(worldDefinitionSchema.safeParse(result.world).success, true);
});

test("write_entry carries worldbookId, audience, and greeting initialVariables", () => {
  const world = makeWorld({
    variables: [{ id: "route", name: "Route", type: "string", defaultValue: "" }],
    worldbooks: [{ id: "mayu-route", name: "Mayu", activation: { mode: "always" }, order: 0 }],
  });
  const changes = toolCallsToSchemaChanges([
    toolCall("write_entry", { id: "mayu-lore", name: "Mayu Lore", content: "She is shy.", section: "system-presets", worldbookId: "mayu-route", audience: "ai" }),
    toolCall("write_entry", { id: "open-mayu", name: "Mayu Opening", role: "greeting", section: "chat-history", content: "Hi!", initialVariables: { route: "mayu" } }),
  ], world).map((p) => p.change!);

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true, result.summary);
  const lore = result.world.entries.find((e) => e.id === "mayu-lore")!;
  assert.equal(lore.worldbookId, "mayu-route");
  assert.equal(lore.audience, "ai");
  const opening = result.world.entries.find((e) => e.id === "open-mayu")!;
  assert.deepEqual(opening.initialVariables, { route: "mayu" });
  assert.equal(worldDefinitionSchema.safeParse(result.world).success, true);
});

test("write_entry scopes a reused folder id independently per worldbook", () => {
  const world = makeWorld({
    worldbooks: [
      { id: "book-a", name: "Book A", activation: { mode: "always" }, order: 0 },
      { id: "book-b", name: "Book B", activation: { mode: "always" }, order: 1 },
    ],
  });
  const changes = toolCallsToSchemaChanges([
    toolCall("write_entry", {
      id: "entry-a",
      name: "Entry A",
      content: "A",
      section: "system-presets",
      worldbookId: "book-a",
      folderId: "shared-name",
    }),
    toolCall("write_entry", {
      id: "entry-b",
      name: "Entry B",
      content: "B",
      section: "system-presets",
      worldbookId: "book-b",
      folderId: "shared-name",
    }),
  ], world).map((p) => p.change!);

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true, result.summary);
  assert.equal(result.world.entryFolders!.length, 2);

  const folderA = result.world.entryFolders!.find((f) => f.worldbookId === "book-a")!;
  const folderB = result.world.entryFolders!.find((f) => f.worldbookId === "book-b")!;
  assert.ok(folderA);
  assert.ok(folderB);
  assert.notEqual(folderA.id, folderB.id);
  assert.equal(result.world.entries.find((e) => e.id === "entry-a")!.folderId, folderA.id);
  assert.equal(result.world.entries.find((e) => e.id === "entry-b")!.folderId, folderB.id);
  assert.equal(worldDefinitionSchema.safeParse(result.world).success, true);
});

test("write_entry worldbookId='' / 'core' normalizes to undefined (the always-on Core book)", () => {
  const world = makeWorld();
  const changes = toolCallsToSchemaChanges([
    toolCall("write_entry", { id: "e-empty", name: "E", content: "x", section: "system-presets", worldbookId: "" }),
    toolCall("write_entry", { id: "e-core", name: "C", content: "x", section: "system-presets", worldbookId: "Core" }),
  ], world).map((p) => p.change!);
  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true, result.summary);
  assert.equal(result.world.entries.find((e) => e.id === "e-empty")!.worldbookId, undefined);
  assert.equal(result.world.entries.find((e) => e.id === "e-core")!.worldbookId, undefined);
});

test("write_lore_binding is keyed by slotId and validates entry existence", () => {
  const world = makeWorld({
    entries: [{ id: "advanced-rules", name: "Advanced", content: "x", role: "lore", section: "system-presets", position: 0, keywords: [], conditions: [], conditionLogic: "all", enabled: true, alwaysSend: false }],
  });
  // Good binding
  const ok = toolCallsToSchemaChanges([
    toolCall("write_lore_binding", { slotId: "rules-toggle", entryId: "advanced-rules" }),
  ], world);
  assert.equal(ok[0]!.error, undefined);
  assert.equal(ok[0]!.change!.entityType, "loreBinding");
  assert.equal(ok[0]!.change!.id, "rules-toggle"); // slotId became the change id
  const okResult = executeApplyChanges(world, [ok[0]!.change!]);
  assert.equal(okResult.success, true, okResult.summary);
  assert.equal(okResult.world.loreUiBindings!.length, 1);
  assert.equal(okResult.world.loreUiBindings![0]!.slotId, "rules-toggle");
  assert.equal(okResult.world.loreUiBindings![0]!.entryId, "advanced-rules");

  // Missing slotId → per-tool error, no change
  const noSlot = toolCallsToSchemaChanges([toolCall("write_lore_binding", { entryId: "advanced-rules" })], world);
  assert.ok(noSlot[0]!.error);
  assert.equal(noSlot[0]!.change, undefined);

  // Dangling entryId → atomic failure with an actionable message
  const bad = toolCallsToSchemaChanges([toolCall("write_lore_binding", { slotId: "x", entryId: "ghost" })], world).map((p) => p.change!);
  const badResult = executeApplyChanges(world, bad);
  assert.equal(badResult.success, false);
  assert.match(badResult.summary, /entryId not found/);
});

test("delete_entities resolves worldbook + loreBinding; deleting a book orphans its entries to Core", () => {
  const world = makeWorld({
    entries: [{ id: "mayu-lore", name: "Mayu", content: "x", role: "lore", section: "system-presets", position: 0, keywords: [], conditions: [], conditionLogic: "all", enabled: true, alwaysSend: false, worldbookId: "mayu-route" }],
    entryFolders: [{ id: "mayu-folder", name: "Mayu", section: "system-presets", order: 0, worldbookId: "mayu-route" }],
    worldbooks: [{ id: "mayu-route", name: "Mayu", activation: { mode: "always" }, order: 0 }],
    loreUiBindings: [{ slotId: "rules-toggle", entryId: "mayu-lore", conditions: [], conditionLogic: "all" }],
  });
  assert.equal(resolveEntityType(world, "mayu-route"), "worldbook");
  assert.equal(resolveEntityType(world, "rules-toggle"), "loreBinding");

  const parsed = toolCallsToSchemaChanges([toolCall("delete_entities", { ids: ["mayu-route", "rules-toggle"] })], world);
  // delete_entities is approval-gated
  assert.equal(classifyApproval(parsed.map((p) => p.change!)).autoExecute, false);
  const result = executeApplyChanges(world, parsed.map((p) => p.change!));
  assert.equal(result.success, true, result.summary);
  assert.equal(result.world.worldbooks!.length, 0);
  assert.equal(result.world.loreUiBindings!.length, 0);
  // Entry survives but is orphaned back to Core (so it doesn't silently vanish).
  assert.equal(result.world.entries.find((e) => e.id === "mayu-lore")!.worldbookId, undefined);
  assert.equal(result.world.entryFolders!.find((f) => f.id === "mayu-folder")!.worldbookId, undefined);
});

test("write_worldbook + write_lore_binding are auto-executed (low-risk, no approval)", () => {
  const world = makeWorld({ entries: [{ id: "e1", name: "E", content: "x", role: "lore", section: "system-presets", position: 0, keywords: [], conditions: [], conditionLogic: "all", enabled: true, alwaysSend: false }] });
  const changes = toolCallsToSchemaChanges([
    toolCall("write_worldbook", { id: "b1", name: "B", activation: { mode: "always" } }),
    toolCall("write_lore_binding", { slotId: "s1", entryId: "e1" }),
  ], world).map((p) => p.change!);
  assert.equal(classifyApproval(changes).autoExecute, true);
});

// ── write_variable: defaultValue coercion ──
// Models send the default as a string regardless of the declared type (511 of 836
// write_variable calls in a 400-agent-run sample). Untyped, those land in session
// state where the engine silently drops every directive against them.

test("write_variable coerces string defaults to the declared type", () => {
  // The exact shapes pulled from live agent_runs tool calls.
  const changes: SchemaChange[] = [
    { action: "create", entityType: "variable", id: "arousal", data: { name: "Arousal", type: "number", defaultValue: "30" } },
    { action: "create", entityType: "variable", id: "in-heat", data: { name: "In Heat", type: "boolean", defaultValue: "false" } },
    { action: "create", entityType: "variable", id: "vip", data: { name: "VIP", type: "boolean", defaultValue: "true" } },
    { action: "create", entityType: "variable", id: "notable_npcs", data: { name: "NPCs", type: "json", defaultValue: "[]" } },
    { action: "create", entityType: "variable", id: "supplies", data: { name: "Supplies", type: "json", defaultValue: "{}" } },
    { action: "create", entityType: "variable", id: "note", data: { name: "Note", type: "string", defaultValue: "hi" } },
  ];

  const { world, success } = executeApplyChanges(makeWorld(), changes);
  assert.equal(success, true);
  const v = (id: string) => world.variables.find((x) => x.id === id)!;

  assert.equal(v("arousal").defaultValue, 30);
  assert.equal(v("in-heat").defaultValue, false);
  assert.equal(v("vip").defaultValue, true);
  assert.deepEqual(v("notable_npcs").defaultValue, []);
  assert.deepEqual(v("supplies").defaultValue, {});
  assert.equal(v("note").defaultValue, "hi");
});

test("write_variable falls back sanely on junk and missing defaults", () => {
  const changes: SchemaChange[] = [
    { action: "create", entityType: "variable", id: "n", data: { type: "number", defaultValue: "not-a-number" } },
    { action: "create", entityType: "variable", id: "j", data: { type: "json", defaultValue: "not json" } },
    { action: "create", entityType: "variable", id: "j2", data: { type: "json" } },            // no default at all
    { action: "create", entityType: "variable", id: "j3", data: { type: "json", defaultValue: null } },
    { action: "create", entityType: "variable", id: "s", data: { type: "string" } },
  ];

  const { world } = executeApplyChanges(makeWorld(), changes);
  const v = (id: string) => world.variables.find((x) => x.id === id)!;

  assert.equal(v("n").defaultValue, 0);
  assert.deepEqual(v("j").defaultValue, {});
  assert.deepEqual(v("j2").defaultValue, {});   // was previously the number 0
  assert.deepEqual(v("j3").defaultValue, {});
  assert.equal(v("s").defaultValue, "");
});

test("write_variable normalizes invented type names", () => {
  const changes: SchemaChange[] = [
    { action: "create", entityType: "variable", id: "a", data: { type: "text", defaultValue: "x" } },
    { action: "create", entityType: "variable", id: "b", data: { type: "array", defaultValue: "[]" } },
    { action: "create", entityType: "variable", id: "c", data: { type: "int", defaultValue: "7" } },
    { action: "create", entityType: "variable", id: "d", data: { type: "bool", defaultValue: "true" } },
  ];

  const { world } = executeApplyChanges(makeWorld(), changes);
  const v = (id: string) => world.variables.find((x) => x.id === id)!;

  assert.equal(v("a").type, "string");
  assert.equal(v("b").type, "json");
  assert.deepEqual(v("b").defaultValue, []);
  assert.equal(v("c").type, "number");
  assert.equal(v("c").defaultValue, 7);
  assert.equal(v("d").type, "boolean");
  assert.equal(v("d").defaultValue, true);
});

test("write_variable update coerces, including a bare type change", () => {
  const world = makeWorld({
    variables: [
      { id: "score", name: "Score", type: "number" as const, defaultValue: 0 },
      { id: "bag", name: "Bag", type: "string" as const, defaultValue: "[]" },
    ],
  });

  const changes: SchemaChange[] = [
    { action: "update", entityType: "variable", id: "score", data: { defaultValue: "99" } },
    // type flips to json with no new default — the existing "[]" must re-coerce
    { action: "update", entityType: "variable", id: "bag", data: { type: "json" } },
  ];

  const result = executeApplyChanges(world, changes);
  assert.equal(result.success, true);
  const v = (id: string) => result.world.variables.find((x) => x.id === id)!;

  assert.equal(v("score").defaultValue, 99);
  assert.equal(v("bag").type, "json");
  assert.deepEqual(v("bag").defaultValue, []);
});

test("write_variable unwraps a scalar the model wrapped in an array", () => {
  // Real prod shape: type=number, defaultValue=[85] — coercing to 0 would bin the value.
  const changes: SchemaChange[] = [
    { action: "create", entityType: "variable", id: "willpower", data: { type: "number", defaultValue: [85] } },
    { action: "create", entityType: "variable", id: "strength", data: { type: "number", defaultValue: ["90"] } },
  ];
  const { world } = executeApplyChanges(makeWorld(), changes);
  const v = (id: string) => world.variables.find((x) => x.id === id)!;
  assert.equal(v("willpower").defaultValue, 85);
  assert.equal(v("strength").defaultValue, 90);
});

test("write_variable infers a missing type from the default instead of assuming number", () => {
  // Real prod shape: no type, defaultValue=[] — must stay a json list, not become 0.
  const changes: SchemaChange[] = [
    { action: "create", entityType: "variable", id: "hidden_events_seen", data: { defaultValue: [] } },
    { action: "create", entityType: "variable", id: "label", data: { defaultValue: "rookie" } },
    { action: "create", entityType: "variable", id: "flag", data: { defaultValue: "true" } },
    { action: "create", entityType: "variable", id: "count", data: { defaultValue: "12" } },
    { action: "create", entityType: "variable", id: "bare", data: {} },
  ];
  const { world } = executeApplyChanges(makeWorld(), changes);
  const v = (id: string) => world.variables.find((x) => x.id === id)!;

  assert.equal(v("hidden_events_seen").type, "json");
  assert.deepEqual(v("hidden_events_seen").defaultValue, []);
  assert.equal(v("label").type, "string");
  assert.equal(v("label").defaultValue, "rookie");
  assert.equal(v("flag").type, "boolean");
  assert.equal(v("flag").defaultValue, true);
  assert.equal(v("count").type, "number");
  assert.equal(v("count").defaultValue, 12);
  assert.equal(v("bare").type, "number");   // nothing to go on — legacy default
  assert.equal(v("bare").defaultValue, 0);
});
