import { test } from "node:test";
import assert from "node:assert/strict";
import { aiLineup } from "./ai-lineup";
import type { PlaceAis, PlaceAiRow } from "./place-ais";

const t = (key: string) => key;
const row = (r: Partial<PlaceAiRow> & Pick<PlaceAiRow, "key" | "name" | "type">): PlaceAiRow => ({ job: "job", memory: "", ...r }) as PlaceAiRow;
const place = (rows: PlaceAiRow[]): PlaceAis => ({ rows, group: false, canKeepNarrator: false, keepsNarrator: false });

const world = {
  worldbooks: [
    { id: "dungeon", station: { kind: "narrator" } },
    { id: "guild", station: { kind: "worker" } },
    { id: "owl", station: { kind: "narrator" } },
  ],
  variables: [
    { id: "v", name: "v", type: "number", defaultValue: 0, precise: true, deltaDown: 5, deltaUp: 5 },
    { id: "w", name: "w", type: "number", defaultValue: 0 },
  ],
  sceneImages: [{ id: "img", url: "x.png", scene: "rain" }],
} as never;

test("each AI once, in the order a turn meets it, the platform's last", () => {
  const places = new Map<string, PlaceAis>([
    ["", place([
      row({ key: "narrator", name: "AI", type: "turn" }),
      row({ key: "guild", bookId: "guild", name: "Guild", type: "turn" }),
      row({ key: "owl", bookId: "owl", name: "Owl Post", type: "ui" }),
    ])],
    ["dungeon", place([row({ key: "dungeon", bookId: "dungeon", name: "Dungeon", type: "turn" })])],
    // The card's AI carrying on inside a situation, and the worker listed again.
    ["guild", place([row({ key: "narrator", name: "AI", type: "turn" }), row({ key: "guild", bookId: "guild", name: "Guild", type: "turn" })])],
  ]);
  const lineup = aiLineup(world, places, (owner) => owner || "card", t);
  const names = Object.fromEntries(lineup.sections.map((s) => [s.id, s.items.map((i) => i.name)]));
  assert.deepEqual(names.answer, ["AI", "Dungeon"]);
  assert.deepEqual(names.after, ["Guild"]);
  assert.deepEqual(names.called, ["Owl Post"]);
  assert.deepEqual(names.platform, ["blueprint.lineup.judge", "blueprint.lineup.repair", "blueprint.lineup.memory", "blueprint.lineup.summary"]);
});

test("no repair AI without a number the AI may write; no judge when continuity is off", () => {
  const lineup = aiLineup({ worldbooks: [], variables: [], continuity: { enabled: false } } as never, new Map([["", place([row({ key: "narrator", name: "AI", type: "turn" })])]]), () => "card", t);
  const platform = lineup.sections.find((s) => s.id === "platform")!.items.map((i) => i.key);
  assert.deepEqual(platform, ["platform:memory", "platform:summary"]);
});

test("switched-off AIs and a narrator standing aside are not in the lineup", () => {
  const lineup = aiLineup(world, new Map([["", place([
    row({ key: "narrator", name: "AI", type: "turn", away: true }),
    row({ key: "owl", bookId: "owl", name: "Owl Post", type: "ui", off: true }),
  ])]]), () => "card", t);
  assert.equal(lineup.sections.some((s) => s.id === "answer" || s.id === "called"), false);
});

test("the repair counts only the numbers the judge does not own", () => {
  const lineup = aiLineup(world, new Map([["", place([row({ key: "narrator", name: "AI", type: "turn" })])]]), () => "card", t);
  const repair = lineup.sections.find((s) => s.id === "platform")!.items.find((i) => i.key === "platform:repair")!;
  assert.equal(repair.values, 1, "w only: v is the judge's");
  const judge = lineup.sections.find((s) => s.id === "platform")!.items.find((i) => i.key === "platform:judge")!;
  assert.equal(judge.values, 1);
});

test("a rules table's seat AI is listed once, with its names and model; story mode has none", () => {
  const places = new Map([["", place([row({ key: "narrator", name: "AI", type: "turn" })])]]);
  const rules = aiLineup({ ...(world as object), settings: { multiplayer: { enabled: true, mode: "rules", minSeats: 2, maxSeats: 4, rulesFile: "rules.js", ai: { names: ["Ann", "Bo"], model: "x/y" } } } } as never, places, () => "card", t);
  const called = rules.sections.find((s) => s.id === "called")!.items;
  assert.deepEqual(called.map((i) => [i.key, i.name, i.job]), [["multiplayer:seats", "blueprint.multiplayer.seatAi", "Ann, Bo · x/y"]]);
  const story = aiLineup({ ...(world as object), settings: { multiplayer: { enabled: true, mode: "story", minSeats: 2, maxSeats: 6 } } } as never, places, () => "card", t);
  assert.equal(story.sections.some((s) => s.id === "called"), false);
});
