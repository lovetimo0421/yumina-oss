import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { GameStateManager, ResponseParser, type JevQuestion, type WorldDefinition } from "@yumina/engine";
import type { StreamChunk } from "../llm/types.js";
import type { MissedUpdateDeps } from "./missed-updates.js";

// Replace external service boundaries before importing the real repair code.
// The isolated server launcher also blocks credentials and external fetches.
const isolatedModules = new Map([
  [new URL("../usage-log.ts", import.meta.url).href, 'export const usageRecords = []; export async function recordUsageLog(args) { usageRecords.push(args.endpoint); }'],
  [new URL("../resolve-provider.ts", import.meta.url).href, 'export async function resolveProviderForModel() { throw new Error("Unexpected live provider resolution in missed-update tests"); }'],
  [new URL("../llm/context-window.ts", import.meta.url).href, 'export function getModelContextWindow() { return 28608; }'],
]);
const isolation = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/db/index.ts")) throw new Error("Missed-update tests must not load a database");
    const source = isolatedModules.get(url);
    return source === undefined ? nextLoad(url, context) : { format: "module", source, shortCircuit: true };
  },
});
const { guardRebuiltBatch, missedUpdateCandidates, missedUpdateQuestions, repairMissedUpdates, usableEffects, repairJsonText, firstJsonObject, MISSED_THRESHOLD } = await import("./missed-updates.js");
const { usageRecords } = await import("../usage-log.js") as unknown as { usageRecords: string[] };
isolation.deregister();

function world(): WorldDefinition {
  return {
    id: "missed-fixture", version: "1.0.0", name: "Missed fixture", description: "", author: "unit",
    entries: [], rules: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1 },
    variables: [
      { id: "body", name: "Body", type: "json", defaultValue: { thirst: 55, energy: 45 }, description: "Thirst and energy", behaviorRules: "Drinking lowers thirst; exertion lowers energy." },
      { id: "pack", name: "Pack", type: "json", defaultValue: [{ id: "bottle", name: "empty bottle" }], description: "Items carried", behaviorRules: "Add or remove items when gained, used or lost." },
      { id: "fallen", name: "Fallen", type: "number", defaultValue: 12, description: "Tributes confirmed dead" },
      { id: "secret", name: "Secret", type: "string", defaultValue: "", aiAccess: "read", description: "Read only" },
      { id: "mood", name: "Mood", type: "string", defaultValue: "calm", options: ["calm", "danger"], precise: true, description: "Scene mood" },
      { id: "bare", name: "Bare", type: "number", defaultValue: 0 },
    ],
  } as WorldDefinition;
}

const chunks = (text: string): StreamChunk[] => [{ type: "text", content: text }, { type: "done", content: "", stopReason: "stop" }];

function deps(answers: Record<string, number>, output: string, calls: { decide: number; repair: number; questions?: Record<string, JevQuestion> }): MissedUpdateDeps {
  return {
    enabled: () => true,
    decide: async (req) => {
      calls.decide++;
      calls.questions = req.questions;
      return { answers: Object.fromEntries(Object.entries(answers).map(([k, p]) => [k, { type: "noul" as const, noul: p }])), usage: { inputTokens: 10, outputTokens: 0 }, model: "typesafe/jev-1.13", ms: 5, keySource: "platform" as const };
    },
    resolveModel: (async () => ({
      provider: { async *generateStream() { calls.repair++; yield* chunks(output); }, async listModels() { return []; } },
      apiKeyTier: "regular", model: "google/gemini-2.5-flash-lite", maxContext: 28_608,
    })) as unknown as MissedUpdateDeps["resolveModel"],
  };
}

function args(overrides: Partial<Parameters<typeof repairMissedUpdates>[0]> = {}) {
  const w = world();
  return {
    world: w, state: new GameStateManager(w).getSnapshot(), playerText: "I drink from the stream.",
    replyText: "You kneel and drink until your stomach aches, then fill the bottle.", effects: [],
    guardCorrected: false, userId: "u1", sessionId: "s1", path: "send" as const, ...overrides,
  };
}

test("candidates: writable, not judge-owned, untouched, described; rules first", () => {
  const w = world();
  const state = new GameStateManager(w).getSnapshot();
  const ids = missedUpdateCandidates(w, state, [{ variableId: "fallen", operation: "add", value: 1 }]).map((v) => v.id);
  assert.deepEqual(ids, ["body", "pack"]);
  // A dot-path write counts as touching its root.
  assert.deepEqual(missedUpdateCandidates(w, state, [{ variableId: "body.thirst", operation: "set", value: 0 }]).map((v) => v.id), ["pack", "fallen"]);
});

test("an authored Health write cannot subtract the injury twice", async () => {
  const w = world();
  w.variables = [{ id: "health", name: "Health", type: "number", defaultValue: 100, description: "Injuries lower health." }];
  const manager = new GameStateManager(w);
  const original = new ResponseParser().parse("You are injured. [Health: subtract 10]");
  assert.equal(original.effects[0]?.variableId, "Health");
  const calls = { decide: 0, repair: 0 };
  const out = await repairMissedUpdates(args({ world: w, state: manager.getSnapshot(), replyText: original.cleanText, effects: original.effects }),
    deps({ health: 1 }, JSON.stringify({ narrative: "", status: "updated", stateChanges: [{ variableId: "health", operation: "subtract", value: 10 }] }), calls));
  manager.applyEffects([...original.effects, ...out.effects]);
  assert.equal(manager.get("health"), 90);
  assert.deepEqual(missedUpdateCandidates(w, manager.getSnapshot(), original.effects), []);
  assert.deepEqual(calls, { decide: 0, repair: 0 });
});

test("ignored nested authored-name writes remain eligible for successful repair", async () => {
  const w = world();
  const manager = new GameStateManager(w);
  const state = manager.getSnapshot();
  const original = new ResponseParser().parse("You drink. [Body.thirst: subtract 10]");
  assert.equal(original.effects[0]?.variableId, "Body.thirst");
  assert.deepEqual(manager.applyEffects(original.effects), []);
  assert.deepEqual(manager.get("body"), { thirst: 55, energy: 45 });
  const calls: { decide: number; repair: number; questions?: Record<string, JevQuestion> } = { decide: 0, repair: 0 };
  const out = await repairMissedUpdates(args({ world: w, state, replyText: original.cleanText, effects: original.effects }),
    deps({ body: 1 }, JSON.stringify({ narrative: "", status: "updated", stateChanges: [{ variableId: "body.thirst", operation: "subtract", value: 10 }] }), calls));
  manager.applyEffects([...original.effects, ...out.effects]);
  assert.deepEqual(manager.get("body"), { thirst: 45, energy: 45 });
  assert.equal(calls.decide, 1);
  assert.equal(calls.repair, 1);
  assert.ok(calls.questions?.body);
  assert.deepEqual(out.effects, [{ variableId: "body.thirst", operation: "subtract", value: 10 }]);
});

test("valid nested-ID writes apply and exclude their roots from repair", () => {
  const w = world();
  const manager = new GameStateManager(w);
  const state = manager.getSnapshot();
  const original = new ResponseParser().parse("You drink. [body.thirst: subtract 10]");
  assert.deepEqual(manager.applyEffects(original.effects).map((e) => e.variableId), ["body"]);
  assert.deepEqual(manager.get("body"), { thirst: 45, energy: 45 });
  assert.deepEqual(missedUpdateCandidates(w, state, original.effects).map((v) => v.id), ["pack", "fallen"]);
});

test("canonical roots prefer IDs over another variable's name", () => {
  const w = world();
  w.variables = [
    { id: "health", name: "Health", type: "number", defaultValue: 100, description: "Health" },
    { id: "Health", name: "Reserve", type: "number", defaultValue: 20, description: "Reserve" },
  ];
  const manager = new GameStateManager(w);
  const effects = [{ variableId: "Health", operation: "subtract" as const, value: 10 }];
  assert.deepEqual(manager.applyEffects(effects).map((e) => e.variableId), ["Health"]);
  assert.deepEqual(missedUpdateCandidates(w, manager.getSnapshot(), effects).map((v) => v.id), ["health"]);
});

test("duplicate authored names resolve to the last variable as in the engine", () => {
  const w = world();
  w.variables = [
    { id: "health", name: "Health", type: "number", defaultValue: 100, description: "Health" },
    { id: "reserve", name: "Health", type: "number", defaultValue: 20, description: "Reserve" },
  ];
  const manager = new GameStateManager(w);
  const effects = [{ variableId: "Health", operation: "subtract" as const, value: 10 }];
  assert.deepEqual(manager.applyEffects(effects).map((e) => e.variableId), ["reserve"]);
  assert.deepEqual(missedUpdateCandidates(w, manager.getSnapshot(), effects).map((v) => v.id), ["health"]);
});

test("already-aborted entry skips decision, resolution, generation and billing", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = { decide: 0, repair: 0 };
  const d = deps({ body: 1 }, "{}", calls);
  let resolutions = 0;
  const resolve = d.resolveModel;
  d.resolveModel = async (id) => { resolutions++; return resolve(id); };
  const before = usageRecords.length;
  const out = await repairMissedUpdates(args({ signal: controller.signal }), d);
  assert.deepEqual(out, { effects: [], flagged: {}, ran: false });
  assert.deepEqual(calls, { decide: 0, repair: 0 });
  assert.equal(resolutions, 0);
  assert.equal(usageRecords.length, before);
});

test("abort while provider resolution is pending starts zero generators", async () => {
  const controller = new AbortController();
  const calls = { decide: 0, repair: 0 };
  const d = deps({ body: 1 }, "{}", calls);
  const resolve = d.resolveModel;
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((r) => { release = r; });
  const resolving = new Promise<void>((r) => { entered = r; });
  d.resolveModel = async (id) => { entered(); await pending; return resolve(id); };
  const result = repairMissedUpdates(args({ signal: controller.signal }), d);
  await resolving;
  const before = usageRecords.length;
  controller.abort();
  release();
  const out = await result;
  assert.equal(calls.repair, 0);
  assert.deepEqual(out, { effects: [], flagged: {}, ran: false });
  assert.equal(usageRecords.length, before, "no repair usage is billed after cancellation during resolution");
});

test("abort during decision skips provider resolution", async () => {
  const controller = new AbortController();
  const calls = { decide: 0, repair: 0 };
  const d = deps({ body: 1 }, "{}", calls);
  const decide = d.decide;
  d.decide = async (req) => { const result = await decide(req); controller.abort(); return result; };
  let resolutions = 0;
  const resolve = d.resolveModel;
  d.resolveModel = async (id) => { resolutions++; return resolve(id); };
  const out = await repairMissedUpdates(args({ signal: controller.signal }), d);
  assert.equal(resolutions, 0);
  assert.equal(calls.repair, 0);
  assert.deepEqual(out, { effects: [], flagged: {}, ran: false });
});

test("abort during generation reaches the provider and prevents retry", async () => {
  const controller = new AbortController();
  const reason = new Error("player stopped");
  const calls = { decide: 0, repair: 0 };
  const d = deps({ body: 1 }, "{}", calls);
  const correction = await d.resolveModel("u1");
  correction.provider.generateStream = async function* (req) {
    calls.repair++;
    assert.equal(req.signal?.aborted, false);
    controller.abort(reason);
    assert.equal(req.signal?.aborted, true);
    assert.equal(req.signal?.reason, reason);
    throw reason;
  };
  d.resolveModel = async () => correction;
  const out = await repairMissedUpdates(args({ signal: controller.signal }), d);
  assert.equal(calls.repair, 1);
  assert.deepEqual(out, { effects: [], flagged: {}, ran: false });
});

test("no confident yes: no correction call, nothing added", async () => {
  const calls = { decide: 0, repair: 0 };
  const out = await repairMissedUpdates(args(), deps({ body: 0.6, pack: 0.2, fallen: 0.01 }, "{}", calls));
  assert.equal(calls.decide, 1);
  assert.equal(calls.repair, 0);
  assert.deepEqual(out.effects, []);
  assert.equal(out.ran, true);
});

test("confident yes: writes only the flagged variables", async () => {
  const calls = { decide: 0, repair: 0 };
  const before = usageRecords.length;
  const batch = JSON.stringify({ narrative: "", status: "updated", stateChanges: [
    { variableId: "body.thirst", operation: "set", value: 0 },
    { variableId: "pack", operation: "set", value: [{ id: "bottle", name: "full bottle" }] },
    { variableId: "fallen", operation: "add", value: 1 },
  ] });
  const out = await repairMissedUpdates(args(), deps({ body: 0.97, pack: 0.93, fallen: 0.1 }, batch, calls));
  assert.equal(out.ran, true);
  assert.equal(calls.decide, 1);
  assert.equal(calls.repair, 1);
  assert.deepEqual(usageRecords.slice(before), ["continuity", "missed-update-repair"]);
  assert.deepEqual(Object.keys(out.flagged).sort(), ["body", "pack"]);
  assert.deepEqual(out.effects.map((e) => e.variableId).sort(), ["body.thirst", "pack"]);
  assert.ok(MISSED_THRESHOLD >= 0.85);
});

test("invalid correction batch is dropped whole", async () => {
  const calls = { decide: 0, repair: 0 };
  const out = await repairMissedUpdates(args(), deps({ body: 0.99 }, "not json at all {", calls));
  assert.equal(calls.repair, 1);
  assert.deepEqual(out.effects, []);
});

test("decision failure lets the turn through untouched", async () => {
  const d = deps({}, "{}", { decide: 0, repair: 0 });
  d.decide = async () => { throw new Error("boom"); };
  const out = await repairMissedUpdates(args(), d);
  assert.deepEqual(out.effects, []);
  assert.equal(out.ran, false);
  assert.equal(out.audit!.status, "error");
  assert.equal(out.audit!.errorCode, "judge-error");
  assert.deepEqual(out.audit!.checked, { body: null, pack: null, fallen: null });
});

test("repair failure retains flagged and negative decisions without provider error text", async () => {
  const d = deps({ body: 0.99, pack: 0.1, fallen: 0.2 }, "{}", { decide: 0, repair: 0 });
  d.resolveModel = async () => { throw new Error("secret provider context"); };
  const out = await repairMissedUpdates(args(), d);
  assert.deepEqual(out.effects, []);
  assert.deepEqual(out.flagged, { body: 0.99 });
  assert.deepEqual(out.audit!.checked, { body: 0.99, pack: 0.1, fallen: 0.2 });
  assert.equal(out.audit!.stage, "repair");
  assert.equal(out.audit!.status, "error");
  assert.doesNotMatch(JSON.stringify(out), /secret provider context/);
});

test("bracket writes count as touched and cannot be repaired twice", () => {
  const w = world();
  const state = new GameStateManager(w).getSnapshot();
  const effects = [{ variableId: "pack[0].name", operation: "set" as const, value: "full bottle" }];
  assert.ok(!missedUpdateCandidates(w, state, effects).some(v => v.id === "pack"));
});

test("only a correction the guard finished counts as a rebuilt batch", () => {
  assert.equal(guardRebuiltBatch({ correctionCount: 1, outcome: "valid-updates" }), true);
  assert.equal(guardRebuiltBatch({ correctionCount: 1, outcome: "explicit-none" }), true);
  // Gave up: the reply's own commands stand, so the repair still runs.
  assert.equal(guardRebuiltBatch({ correctionCount: 1, outcome: "unverified" }), false);
  assert.equal(guardRebuiltBatch({ correctionCount: 1, outcome: "failed-open" }), false);
  assert.equal(guardRebuiltBatch({ correctionCount: 0, outcome: "valid-updates" }), false);
});

test("skips when the guard already rebuilt the batch, or nothing to ask", async () => {
  const calls = { decide: 0, repair: 0 };
  assert.equal((await repairMissedUpdates(args({ guardCorrected: true }), deps({ body: 1 }, "{}", calls))).ran, false);
  assert.equal((await repairMissedUpdates(args({ replyText: "  " }), deps({ body: 1 }, "{}", calls))).ran, false);
  assert.equal(calls.decide, 0);
});

test("Chinese replies get Chinese questions in the author's words", async () => {
  const calls: { decide: number; repair: number; questions?: Record<string, JevQuestion> } = { decide: 0, repair: 0 };
  await repairMissedUpdates(args({ replyText: "你跪在溪边喝了个够，又把水壶灌满了。" }), deps({}, "{}", calls));
  const q = calls.questions?.body;
  assert.equal(q?.type, "noul");
  assert.match(q!.instructions, /作者写的更新规则：Drinking lowers thirst/);
  const en = missedUpdateQuestions(world().variables.slice(0, 1), args().state, false).body!;
  assert.match(en.instructions, /The author's update rule: Drinking lowers thirst/);
});

test("one bad operation costs only itself; no-op writes are dropped", () => {
  const a = args();
  const text = JSON.stringify({ narrative: "", status: "updated", stateChanges: [
    { variableId: "body.thirst", operation: "set", value: 10 },
    { variableId: "pack", operation: "frobnicate", value: 1 },
    { variableId: "fallen", operation: "set", value: 12 },
  ] });
  const kept = usableEffects(a, ["body", "pack", "fallen"], text);
  assert.deepEqual(kept.map((e) => e.variableId), ["body.thirst"]);
});

test("bare quotes inside story text are repaired, not fatal", () => {
  const broken = '{"narrative":"","status":"updated","stateChanges":[{"variableId":"pack","operation":"set","value":[{"id":"note","name":"纸条上写着"快跑""}]}]}';
  const kept = usableEffects(args(), ["pack"], repairJsonText(broken));
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.variableId, "pack");
  const midSentence = '{"narrative":"","status":"updated","stateChanges":[{"variableId":"pack","operation":"push","value":{"id":"note","name":"他低声说"别动"，然后离开了"}}]}';
  assert.equal(usableEffects(args(), ["pack"], repairJsonText(midSentence)).length, 1);
});

test("a repeated tail after a complete object is dropped", () => {
  const good = '{"narrative":"","status":"updated","stateChanges":[{"variableId":"fallen","operation":"add","value":1,"note":"a \\"quoted\\" } brace"}]}';
  assert.equal(firstJsonObject(good + '\nactive":"active"}}]}\n]}'), good);
  assert.equal(firstJsonObject("no json"), "no json");
});
