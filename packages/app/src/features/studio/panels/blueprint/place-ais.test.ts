import assert from "node:assert/strict";
import test from "node:test";
import type { WorldDefinition } from "@yumina/engine";
import { aiTypeOf, livesSomewhere, placeAis } from "./place-ais";

const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}${JSON.stringify(opts)}` : key);
const world = {
  name: "旧书店",
  settings: {},
  entries: [],
  worldbooks: [
    { id: "attic", name: "阁楼", order: 1, activation: { mode: "keywords", keywords: ["阁楼"] } },
    { id: "cat", name: "店猫", order: 0, host: "card", activation: { mode: "always" }, station: { kind: "narrator", memoryPool: "pool-cat", onClose: "keep" } },
    { id: "guide", name: "引路人", order: 1, host: "attic", activation: { mode: "always" }, station: { kind: "narrator", inputs: [{ kind: "worker", from: "diary" }] } },
    { id: "diary", name: "战地日记", order: 2, host: "attic", activation: { mode: "always" }, station: { kind: "worker", trigger: { on: "turns", every: 3 }, task: "记", inputs: [{ kind: "transcript", from: "core", limit: 20 }] } },
    { id: "loose", name: "新的 AI", order: 3, host: "unplaced", activation: { mode: "always" }, station: { kind: "narrator" } },
  ],
} as unknown as WorldDefinition;

test("the card: its own AI, then the AIs that live on the card — a group chat; one put nowhere is shown off", () => {
  const card = placeAis(world, undefined, t);
  assert.deepEqual(card.rows.map((r) => r.name), ["blueprint.placeAis.defaultName", "店猫", "新的 AI"]);
  assert.deepEqual(card.rows.map((r) => r.type), ["turn", "turn", "turn"]);
  assert.equal(card.rows[2]!.off, true);
  assert.equal(card.group, true, "the one put nowhere does not answer");
  assert.match(card.rows[1]!.memory, /memOwn/);
});

test("the three types, by what calls the AI", () => {
  assert.equal(aiTypeOf({ kind: "narrator" }), "turn");
  assert.equal(aiTypeOf({ kind: "worker", trigger: { on: "turns", every: 3 } }), "turn");
  assert.equal(aiTypeOf({ kind: "worker", trigger: { on: "after", from: "x" } }), "turn");
  assert.equal(aiTypeOf({ kind: "worker", trigger: { on: "ui" } }), "ui");
  assert.equal(aiTypeOf({ kind: "worker", trigger: { on: "conditions", conditions: [] } }), "code");
  assert.equal(aiTypeOf({ kind: "worker", trigger: { on: "quiet", seconds: 60 } }), "code");
});

test("a situation with an AI of its own: the narrator steps aside, the writer hands on", () => {
  const attic = placeAis(world, "attic", t);
  assert.deepEqual(attic.rows.map((r) => r.key), ["narrator", "guide", "diary"]);
  assert.equal(attic.rows[0]!.away, true);
  assert.equal(attic.group, false);
  assert.match(attic.rows[1]!.link ?? "", /linkReceives.*战地日记/);
  assert.match(attic.rows[2]!.link ?? "", /linkWrites.*引路人/);
  assert.match(attic.rows[2]!.job, /jobEveryTurns/);
});

test("keeping the narrator makes it a group chat", () => {
  const kept = { ...world, worldbooks: world.worldbooks!.map((b) => (b.id === "attic" ? { ...b, narratorHere: true } : b)) };
  const attic = placeAis(kept, "attic", t);
  assert.equal(attic.rows[0]!.away, undefined);
  assert.equal(attic.group, true);
});

test("no AI is a frame: every one is a row; a scenario is still a scenario", () => {
  const books = world.worldbooks!;
  assert.deepEqual(books.filter(livesSomewhere).map((b) => b.id), ["cat", "guide", "diary", "loose"]);
});
