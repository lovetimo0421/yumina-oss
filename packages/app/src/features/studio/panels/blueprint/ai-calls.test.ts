import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { WorldDefinition, Worldbook } from "@yumina/engine";
import { PLAY_MODELS } from "@yumina/shared";
import { aiCallRows } from "./ai-calls";
import { modelReach, stationDefaultMaxTokens } from "@/features/editor/lib/ai-call-settings";

const t = (key: string, opts?: Record<string, unknown>) => {
  const args = Object.entries(opts ?? {}).filter(([k]) => k !== "ns").map(([k, v]) => `${k}=${v}`).join(",");
  return args ? `${key}(${args})` : key;
};
const book = (id: string, name: string, station?: Worldbook["station"], extra: Partial<Worldbook> = {}): Worldbook =>
  ({ id, name, order: 0, activation: { mode: "always" }, ...(station ? { station } : {}), ...extra }) as Worldbook;
const world = (worldbooks: Worldbook[], settings: Record<string, unknown> = {}, files?: Record<string, string>) =>
  ({ entries: [], variables: [], worldbooks, settings, ...(files ? { rootComponent: { files } } : {}) }) as unknown as WorldDefinition;

const freeModel = PLAY_MODELS.find((m) => m.minPlan === "free")!;
const paidModel = PLAY_MODELS.find((m) => m.minPlan !== "free")!;

test("the story AI follows the player, and says the model the card recommends", () => {
  const [story] = aiCallRows(world([], { recommendedModel: freeModel.id }), t);
  assert.equal(story!.kind, "story");
  assert.equal(story!.model.mode, "player");
  assert.match(story!.model.note!, new RegExp(`recommended\\(model=${freeModel.name}`));
  assert.equal(story!.params.mode, "player");
});

test("a card that locks its sampling shows its own values, clamped", () => {
  const [story] = aiCallRows(world([], { samplingPolicy: "author", temperature: 1.9, topP: 0.9 }), t);
  assert.equal(story!.params.mode, "author");
  assert.match(story!.params.text, /temperature\(v=1.5\)/);
  assert.match(story!.params.text, /topP\(v=0.9\)/);
  assert.match(story!.params.note!, /lengthPlayer/);
});

test("an AI always in the card's place means the story AI never runs", () => {
  const rows = aiCallRows(world([book("inn", "客栈", { kind: "narrator" })]), t);
  assert.equal(rows[0]!.off, true);
  assert.match(rows[0]!.when, /storyTakenOver\(name=客栈\)/);
});

test("a narrator's paid model warns that cheaper plans get their own model", () => {
  const rows = aiCallRows(world([book("yard", "老板娘", { kind: "narrator", model: paidModel.id }, { activation: { mode: "keywords", keywords: ["后院"] } } as Partial<Worldbook>)]), t);
  const yard = rows.find((r) => r.key === "book:yard")!;
  assert.equal(yard.model.mode, "author");
  assert.match(yard.model.warn!, /modelShut\.player\(plans=planName\.free/);
  // It answers the player's turn like the story AI.
  assert.equal(yard.params.mode, "player");
});

test("a background AI runs on the default model at 0.2 unless the author sets its own", () => {
  const rows = aiCallRows(world([
    book("notes", "记录员", { kind: "worker", trigger: { on: "turns", every: 3 }, task: "x" }, { host: "card" }),
    book("judge", "裁判", { kind: "worker", trigger: { on: "ui" }, temperature: 0.7, maxTokens: 9000, model: "nobody/unknown-model" }, { host: "card" }),
  ]), t);
  const notes = rows.find((r) => r.key === "book:notes")!;
  assert.equal(notes.kind, "behind");
  assert.equal(notes.model.mode, "default");
  assert.equal(notes.params.mode, "default");
  assert.match(notes.params.note!, /temperature\(v=0.2\).*maxTokens\(n=900\)/);
  const judge = rows.find((r) => r.key === "book:judge")!;
  assert.equal(judge.kind, "ui");
  assert.match(judge.params.text, /temperature\(v=0.7\).*maxTokens\(n=4000\)/);
  assert.match(judge.model.warn!, /modelUnknown\.default/);
});

test("calls in the card's code: session follows the player, raw takes the code's values or its defaults", () => {
  const files = {
    "index.tsx": [
      `await api.ai.complete({ context: "session", messages });`,
      `await api.ai.complete({ messages, temperature: 0.4 });`,
      `await api.ai.complete({ context: "session", messages, temperature: heat });`,
    ].join("\n"),
  };
  const code = aiCallRows(world([], {}, files), t).filter((r) => r.kind === "code");
  assert.equal(code.length, 3);
  assert.equal(code[0]!.params.mode, "player");
  assert.equal(code[0]!.model.mode, "player");
  assert.match(code[1]!.params.text, /temperature\(v=0.4\).*maxTokens\(n=2048\)/);
  assert.equal(code[2]!.params.mode, "code");
  assert.deepEqual(code[0]!.open, { kind: "code", file: "index.tsx", line: 1 });
});

test("the catalog says who cannot run a model", () => {
  assert.deepEqual(modelReach(freeModel.id).shut, []);
  assert.ok(modelReach(paidModel.id).shut.includes("free"));
  assert.equal(modelReach("nobody/unknown-model").known, false);
  assert.equal(stationDefaultMaxTokens({ kind: "custom" }), 800);
  assert.equal(stationDefaultMaxTokens({ kind: "worker", trigger: { on: "quiet", seconds: 60 } }), 900);
});
