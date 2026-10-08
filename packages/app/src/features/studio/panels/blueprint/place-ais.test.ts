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

test("an AI call written in the interface code is a row: on the card every call, in a situation the calls that read it", () => {
  const coded = {
    ...world,
    rootComponent: {
      id: "r", name: "Stage", entryFile: "index.tsx", updatedAt: "",
      files: {
        "index.tsx": "export default function App(){ return React.createElement(Chat); }",
        "director.ts": "await api.ai.complete({ messages, context:'session', includeLorebook:'matched', worldbookIds:['attic'], responseFormat:{type:'json_object'} });\nawait api.ai.decide({ questions });",
      },
    },
  } as unknown as WorldDefinition;
  const card = placeAis(coded, undefined, t);
  const code = card.rows.filter((r) => r.code);
  assert.deepEqual(code.map((r) => r.key), ["code:director.ts:1", "code:director.ts:2"]);
  assert.deepEqual(code.map((r) => r.type), ["code", "code"]);
  assert.equal(code[0]!.name, "阁楼", "named for the situation it reads");
  assert.match(code[0]!.link!, /linkReadsModules/);
  assert.match(code[0]!.memory, /memLoreMatched/);
  assert.match(code[1]!.name, /codeCallName/, "a call that names no situation is named for its file");
  assert.equal(card.group, true, "code calls never count as voices");

  const attic = placeAis(coded, "attic", t);
  assert.deepEqual(attic.rows.filter((r) => r.code).map((r) => r.key), ["code:director.ts:1"]);
  assert.match(attic.rows.find((r) => r.code)!.job, /jobFromCodeHere/);
  assert.equal(placeAis(coded, "cat", t).rows.some((r) => r.code), false);
});

test("a custom AI is a declared slot: implemented by the code call that reads it, or not yet", () => {
  const coded = {
    ...world,
    worldbooks: [
      ...(world.worldbooks ?? []),
      { id: "still-estragon", name: "Estragon", order: 9, host: "card", activation: { mode: "always" }, station: { kind: "custom" } },
      { id: "warden", name: "Warden", order: 10, host: "card", activation: { mode: "always" }, station: { kind: "custom" } },
    ],
    rootComponent: {
      id: "r", name: "Stage", entryFile: "index.tsx", updatedAt: "",
      files: { "use-still.ts": "await api.ai.complete({ messages, includeLorebook: 'matched', worldbookIds: [`still-${who}`] });" },
    },
  } as unknown as WorldDefinition;
  const card = placeAis(coded, undefined, t);
  const estragon = card.rows.find((r) => r.bookId === "still-estragon")!;
  assert.equal(estragon.type, "custom");
  assert.match(estragon.job, /jobImplemented/);
  assert.equal(estragon.code?.file, "use-still.ts");
  const warden = card.rows.find((r) => r.bookId === "warden")!;
  assert.match(warden.job, /jobUnimplemented/);
  assert.equal(card.rows.filter((r) => r.key.startsWith("code:")).length, 0, "the implementing call is the AI's row, not a second row");
  assert.equal(aiTypeOf({ kind: "custom" }), "custom");
});
