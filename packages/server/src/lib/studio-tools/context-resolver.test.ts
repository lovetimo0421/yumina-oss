import test from "node:test";
import assert from "node:assert/strict";
import type { WorldDefinition } from "@yumina/engine";
import { buildInventory, extractKeywords, toStringArray } from "./context-resolver.js";

// ── toStringArray ──
// Regression: a lorebook entry whose `keywords`/`tags` were persisted as a
// string (LLM tool call emitted "a, b" instead of ["a","b"]) used to crash the
// Studio AI with `e.keywords.slice(...).join is not a function`.

test("toStringArray passes a string array through unchanged", () => {
  assert.deepEqual(toStringArray(["idol", "kpop"]), ["idol", "kpop"]);
});

test("toStringArray splits a comma-separated string into a trimmed array", () => {
  assert.deepEqual(toStringArray("idol, kpop ,stay"), ["idol", "kpop", "stay"]);
});

test("toStringArray wraps a single bare string", () => {
  assert.deepEqual(toStringArray("idol"), ["idol"]);
});

test("toStringArray returns [] for null/undefined/object/number", () => {
  assert.deepEqual(toStringArray(undefined), []);
  assert.deepEqual(toStringArray(null), []);
  assert.deepEqual(toStringArray(42), []);
  assert.deepEqual(toStringArray({ a: 1 }), []);
});

test("toStringArray drops non-string array members and empty fragments", () => {
  assert.deepEqual(toStringArray(["ok", 3, null, "two"]), ["ok", "two"]);
  assert.deepEqual(toStringArray("a,, ,b"), ["a", "b"]);
});

// ── extractKeywords ──

test("extractKeywords extracts meaningful words and filters stop words", () => {
  const keywords = extractKeywords("Create a tavern entry with a mysterious bartender");
  assert.ok(keywords.includes("tavern"));
  assert.ok(keywords.includes("mysterious"));
  assert.ok(keywords.includes("bartender"));
  assert.ok(keywords.includes("entry"));
  // Stop words filtered
  assert.ok(!keywords.includes("a"));
  assert.ok(!keywords.includes("with"));
  assert.ok(!keywords.includes("create"));
});

test("extractKeywords handles empty input", () => {
  const keywords = extractKeywords("");
  assert.equal(keywords.length, 0);
});

test("extractKeywords handles whitespace-only input", () => {
  const keywords = extractKeywords("   ");
  assert.equal(keywords.length, 0);
});

test("extractKeywords strips punctuation", () => {
  const keywords = extractKeywords("What's the bartender's name?");
  assert.ok(keywords.includes("bartender"));
  assert.ok(!keywords.includes("?"));
});

test("extractKeywords filters single-character words", () => {
  const keywords = extractKeywords("I want a b c variable");
  assert.ok(!keywords.includes("b"));
  assert.ok(!keywords.includes("c"));
  assert.ok(keywords.includes("variable"));
});

test("extractKeywords handles kebab-case entity names", () => {
  const keywords = extractKeywords("update the combat-system entry");
  assert.ok(keywords.includes("combat-system"));
});

test("extractKeywords normalizes to lowercase", () => {
  const keywords = extractKeywords("Make the BARTENDER more MYSTERIOUS");
  assert.ok(keywords.includes("bartender"));
  assert.ok(keywords.includes("mysterious"));
});

// ── buildInventory: the blackboard reaches the agent ──
// A module's sticky note and the canvas's free-floating notes are the
// creator's design intent — if they fall out of the snapshot, the AI is
// editing a card whose blueprint it never saw.

function blackboardWorld(): WorldDefinition {
  return {
    id: "w",
    version: "1.0.0",
    name: "Blackboard",
    description: "",
    author: "t",
    entries: [],
    variables: [],
    rules: [],
    reactions: [],
    components: [],
    audioTracks: [],
    customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
    worldbooks: [
      {
        id: "wb-dungeon",
        name: "副本：幸福之家",
        note: "D级副本。通关或失败后context要wipe，只留结算。",
        activation: { mode: "always" },
        order: 0,
      },
    ],
    graphLayout: {
      version: 3,
      nodes: {},
      notes: [
        { id: "n1", x: 0, y: 0, w: 240, h: 150, text: "整张卡=无限流大世界，每个副本一个模块" },
        { id: "n2", x: 0, y: 0, w: 240, h: 150, text: "   " },
      ],
    },
  } as unknown as WorldDefinition;
}

test("buildInventory carries a module's sticky note", () => {
  const inv = buildInventory(blackboardWorld(), []);
  assert.match(inv, /wb-dungeon/);
  assert.match(inv, /note: D级副本。通关或失败后context要wipe，只留结算。/);
});

test("buildInventory lists non-empty canvas notes and skips blank ones", () => {
  const inv = buildInventory(blackboardWorld(), []);
  assert.match(inv, /CANVAS NOTES \(1\)/);
  assert.match(inv, /无限流大世界/);
});

test("buildInventory names a narrator station and says its span archives", () => {
  const world = blackboardWorld();
  (world.worldbooks![0]! as { station?: unknown }).station = { kind: "narrator" };
  const inv = buildInventory(world, []);
  assert.match(inv, /NARRATOR station/);
  // The default is archive, and the agent has to know that without being told
  // twice — a module IS a run.
  assert.match(inv, /folds into a summary/);
});

test("buildInventory describes a worker's wiring, and says plainly when it cannot run", () => {
  const world = blackboardWorld();
  (world.worldbooks![0]! as { station?: unknown }).station = {
    kind: "worker",
    model: "cheap/model",
    inputs: [{ kind: "memory", from: "wb-other", as: "lore", limit: 3 }],
  };
  const inv = buildInventory(world, []);
  assert.match(inv, /WORKER station/);
  assert.match(inv, /model: cheap\/model/);
  assert.match(inv, /context in: memory<-wb-other\(lore, 3\)/);
  // A worker with no trigger and no task is a module that will never do
  // anything. The snapshot must not let the agent believe otherwise.
  assert.match(inv, /runs: NEVER/);
  assert.match(inv, /task: NONE SET/);
});

test("buildInventory still reads a legacy card written before stations existed", () => {
  const world = blackboardWorld();
  (world.worldbooks![0]! as { runScoped?: boolean }).runScoped = true;
  const inv = buildInventory(world, []);
  assert.match(inv, /NARRATOR station/);
});

test("buildInventory says nothing about a plain content module", () => {
  const inv = buildInventory(blackboardWorld(), []);
  assert.ok(!inv.includes("station"));
});

test("buildInventory says nothing about notes when there are none", () => {
  const world = blackboardWorld();
  world.worldbooks![0]!.note = undefined;
  world.graphLayout!.notes = [];
  const inv = buildInventory(world, []);
  assert.ok(!inv.includes("CANVAS NOTES"));
  assert.ok(!inv.includes("📌"));
});

test("buildInventory names a custom AI slot and whether code implements it", () => {
  const world = blackboardWorld();
  const book = world.worldbooks![0]! as { id: string; station?: unknown };
  book.station = { kind: "custom" };
  let inv = buildInventory(world, []);
  assert.match(inv, /CUSTOM SLOTS/);
  assert.match(inv, /CUSTOM AI \(自定义\).*NOT IMPLEMENTED YET/);
  (world as { rootComponent?: unknown }).rootComponent = {
    id: "r", name: "x", entryFile: "index.tsx", updatedAt: "",
    files: { "index.tsx": `await api.ai.complete({ messages, worldbookIds: ["${book.id}"] });` },
  };
  inv = buildInventory(world, []);
  assert.match(inv, /implemented by index\.tsx:1 \(api\.ai\.complete\)/);
});

test("buildInventory names a custom behaviour and what fires it", () => {
  const world = blackboardWorld();
  (world as { reactions?: unknown[] }).reactions = [{ id: "rx-1", name: "结算", when: { eventType: "ui:action" }, conditions: [], conditionLogic: "all", then: [], priority: 0, enabled: true, custom: true }];
  let inv = buildInventory(world, []);
  assert.match(inv, /rx-1: "结算".*CUSTOM \(自定义\).*NOT IMPLEMENTED YET/);
  (world as { rootComponent?: unknown }).rootComponent = { id: "r", name: "x", entryFile: "index.tsx", updatedAt: "", files: { "index.tsx": "x\napi.executeAction('rx-1')" } };
  inv = buildInventory(world, []);
  assert.match(inv, /implemented by interface code at index\.tsx:2/);
});
