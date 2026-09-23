import test from "node:test";
import assert from "node:assert/strict";
import { GameStateManager, ResponseParser, type WorldDefinition } from "@yumina/engine";
import type { TurnOutputContext } from "../../lib/extension-hooks.js";
import type { GenerateParams, StreamChunk } from "../../lib/llm/types.js";
import { guardTurnOutput, StateGuardError, boundedCorrectionInputTokens, estimateCorrectionUsageTokens } from "./validate.js";

const none = '<yumina-state version="1" status="none" />';
const updated = (n: number) => `<yumina-state version="1" status="updated" count="${n}" />`;
const reviewedNone = JSON.stringify({ narrative: "", status: "none", stateChanges: [], review: [
  { variableId: "kills-id", reason: "No kill occurs in the draft." },
  { variableId: "energy-id", reason: "No physical activity occurs in the draft." },
] });
function fixture(raw = "The stranger waits.", chunks: StreamChunk[] = [{ type: "text", content: reviewedNone }, { type: "done", content: "", stopReason: "end_turn" }]) {
  const world: WorldDefinition = {
    id: "guard-fixture", version: "1.0.0", name: "Guard fixture", description: "", author: "unit",
    entries: [], rules: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1 },
    variables: [{ id: "kills-id", name: "kills", type: "number", defaultValue: 0 }, { id: "energy-id", name: "energy", type: "number", defaultValue: 100 }],
  };
  const requests: GenerateParams[] = [];
  const usages: Array<{ model: string; totalTokens: number }> = [];
  const progress: string[] = [];
  const controller = new AbortController();
  const ctx: TurnOutputContext = {
    world, state: new GameStateManager(world).getSnapshot(), raw, parsed: new ResponseParser().parse(raw),
    model: "selected/provider-model", maxContext: 128_000, signal: controller.signal,
    provider: { async *generateStream(params) { requests.push(params); yield* chunks; }, async listModels() { return []; } },
    audit: { version: 1, attemptId: "test", path: "send", outcome: "validating", diagnostics: [], parsedCount: 0, repaired: false, correctionCount: 0, model: "selected/provider-model", apiKeyTier: "byok", startedAt: new Date().toISOString(), baselineFingerprint: "test", usageLogIds: [] },
    history: [], mayCorrect: async () => true,
    progress: async (audit) => { progress.push(audit.outcome); },
    recordUsage: async (usage, model) => { usages.push({ ...usage, model }); return `usage-${usages.length}`; },
  };
  return { ctx, requests, usages, progress, controller };
}
const errorCode = (code: string) => (error: unknown) => error instanceof StateGuardError && error.code === code;

function readonlyFixture(stateChanges: unknown[], review?: unknown) {
  const output = JSON.stringify({ narrative: "", status: "updated", stateChanges, ...(review === undefined ? {} : { review }) });
  const f = fixture("You catch your breath.", [{ type: "text", content: output }, { type: "done", content: "", stopReason: "stop" }]);
  f.ctx.world.variables.push(
    { id: "game-day", name: "Calendar", type: "number", defaultValue: 1, aiAccess: "read" },
    { id: "calendar", name: "Calendar details", type: "json", defaultValue: { days: [1] }, aiAccess: "read" },
  );
  f.ctx.state = new GameStateManager(f.ctx.world).getSnapshot();
  return { ...f, output };
}

for (const [variableId, value] of [["game-day", 0], ["game-day", 10], ["Calendar", 1], ["calendar.days[0]", 1], ["Calendar details.days.0", 1]] as const) {
  test(`correction discards read-only ${variableId} add ${value} and keeps validated writable effects`, async () => {
    const writable = { variableId: "energy-id", operation: "add", value: 2 };
    const f = readonlyFixture([writable, { variableId, operation: "add", value }]);
    const before = structuredClone(f.ctx.state);
    const result = await guardTurnOutput(f.ctx);
    assert.deepEqual(result.parsed.effects, [writable]);
    assert.equal(result.audit?.parsedCount, 1);
    assert.equal(result.audit?.declaredCount, 1);
    assert.equal(result.audit?.repaired, true);
    assert.ok(result.audit?.diagnostics.includes("read_only_correction_ignored"));
    assert.equal(result.audit?.correctedBatch, f.output);
    assert.equal(result.parsed.cleanText, f.ctx.raw);
    assert.deepEqual(f.ctx.state, before);
    assert.equal(f.requests.length, 1);
    assert.equal(f.usages.length, 1);
    const committed = new GameStateManager(f.ctx.world, structuredClone(before));
    committed.applyEffects(result.parsed.effects);
    assert.equal(committed.get("energy-id"), 102);
    assert.equal(committed.get("game-day"), 1);
    assert.deepEqual(committed.get("calendar"), { days: [1] });
  });
}

test("read-only filtering composes with syntax recovery and preserves original audit bytes", async () => {
  const writable = { variableId: "energy-id", operation: "add", value: 2 };
  const f = readonlyFixture([writable, { variableId: "game-day", operation: "add", value: 0 }]);
  const output = '<think>Planning.</think>\n```json\n' + f.output + '],"review":[]}\n```';
  f.ctx.provider.generateStream = async function* () {
    yield { type: "text", content: output };
    yield { type: "done", content: "", stopReason: "stop" };
  };
  const result = await guardTurnOutput(f.ctx);
  assert.deepEqual(result.parsed.effects, [writable]);
  assert.equal(result.audit?.repaired, true);
  assert.equal(result.audit?.correctedBatch, output);
});

test("read-only aliases never shadow writable IDs and duplicate aliases resolve last", async () => {
  const writable = { variableId: "energy-id", operation: "add", value: 2 };
  const f = readonlyFixture([writable, { variableId: "Calendar", operation: "add", value: 1 }, { variableId: "calendar.days[0]", operation: "add", value: 1 }]);
  f.ctx.world.variables[2]!.name = "energy-id";
  f.ctx.world.variables.push(
    { id: "first-alias", name: "Calendar", type: "number", defaultValue: 0, aiAccess: "read" },
    { id: "last-alias", name: "Calendar", type: "number", defaultValue: 0 },
  );
  f.ctx.state = new GameStateManager(f.ctx.world).getSnapshot();
  assert.deepEqual((await guardTurnOutput(f.ctx)).parsed.effects, [writable, { variableId: "last-alias", operation: "add", value: 1 }]);
  f.ctx.world.variables.at(-1)!.aiAccess = "read";
  assert.deepEqual((await guardTurnOutput(f.ctx)).parsed.effects, [writable]);
});

for (const protection of [{ enabled: false }, { internal: true }, { activation: { mode: "conditions" as const, conditions: [{ variableId: "kills-id", operator: "gt" as const, value: 0 }], conditionLogic: "all" as const } }]) {
  test(`inactive/hidden read-only targets stay rejected ${JSON.stringify(protection)}`, async () => {
    const f = readonlyFixture([{ variableId: "game-day", operation: "add", value: 0 }, { variableId: "energy-id", operation: "add", value: 1 }]);
    Object.assign(f.ctx.world.variables[2]!, protection);
    await assert.rejects(guardTurnOutput(f.ctx), errorCode("invalid_correction"));
    assert.equal(f.ctx.state.variables["game-day"], 1);
    assert.equal(f.ctx.state.variables["energy-id"], 100);
  });
}

test("read-only-only correction cannot stand in for a missing writable-variable review", async () => {
  const f = readonlyFixture([{ variableId: "game-day", operation: "add", value: 0 }]);
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("invalid_correction"));
  assert.ok(f.ctx.audit.diagnostics.includes("missing_no_update_review"));
  assert.equal(f.ctx.state.variables["game-day"], 1);
});

test("read-only-only correction with a complete review becomes an explicit no-change batch", async () => {
  const f = readonlyFixture([{ variableId: "game-day", operation: "add", value: 1 }], JSON.parse(reviewedNone).review);
  const result = await guardTurnOutput(f.ctx);
  assert.equal(result.audit?.outcome, "explicit-none");
  assert.deepEqual(result.parsed.effects, []);
  assert.equal(result.audit?.declaredCount, 0);
  assert.equal(result.audit?.correctedBatch, f.output);
});

for (const bad of [
  { variableId: "missing", operation: "set", value: 1 },
  { variableId: "energy-id", operation: "add", value: "two" },
  { variableId: "calendar.__proto__.polluted", operation: "set", value: true },
  { variableId: "game-day", operation: "unknown", value: 1 },
]) {
  test(`read-only filtering does not hide invalid command ${bad.variableId}/${bad.operation}`, async () => {
    const f = readonlyFixture([{ variableId: "game-day", operation: "add", value: 0 }, bad]);
    await assert.rejects(guardTurnOutput(f.ctx), errorCode("invalid_correction"));
    assert.equal(f.ctx.state.variables["game-day"], 1);
  });
}

for (const protection of [{ aiAccess: "none" as const }, { enabled: false }, { internal: true }]) {
  test(`read-only filtering does not bypass other access restrictions ${JSON.stringify(protection)}`, async () => {
    const f = readonlyFixture([{ variableId: "game-day", operation: "add", value: 0 }, { variableId: "energy-id", operation: "add", value: 1 }]);
    Object.assign(f.ctx.world.variables[1]!, protection);
    await assert.rejects(guardTurnOutput(f.ctx), errorCode("invalid_correction"));
    assert.equal(f.ctx.state.variables["energy-id"], 100);
  });
}

test("correction requests native JSON mode without changing story output", async () => {
  const f = fixture();
  const result = await guardTurnOutput(f.ctx);
  assert.deepEqual(f.requests[0]!.responseFormat, { type: "json_object" });
  assert.equal(result.parsed.cleanText, f.ctx.raw);
});

for (const thrown of [false, true]) {
  test(`explicit JSON-mode rejection falls back once on the same provider (${thrown ? "throw" : "chunk"})`, async () => {
    const f = fixture();
    f.ctx.provider.generateStream = async function* (params) {
      f.requests.push(params);
      if (f.requests.length === 1) {
        if (thrown) throw new Error("400 response_format json_object is not supported");
        yield { type: "error", content: "400 response_format json_object is not supported" };
        return;
      }
      yield { type: "text", content: reviewedNone };
      yield { type: "done", content: "", stopReason: "stop", usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } };
    };
    const result = await guardTurnOutput(f.ctx);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.requests[0]!.responseFormat, { type: "json_object" });
    assert.equal(f.requests[1]!.responseFormat, undefined);
    assert.equal(f.requests[1]!.model, f.requests[0]!.model);
    assert.equal(f.requests[1]!.signal, f.requests[0]!.signal, "same deadline and cancellation budget");
    assert.deepEqual(f.requests[1]!.messages, f.requests[0]!.messages);
    assert.equal(result.audit?.correctionCount, 1, "one generated correction, not two paid repairs");
    assert.equal(f.usages.length, 1);
    assert.equal(f.usages[0]!.totalTokens, 30);
  });
}

test("production trailing closers preserve the writable update, frozen narration and raw audit", async () => {
  const output = '{"narrative":"","status":"updated","stateChanges":[{"variableId":"energy-id","operation":"add","value":1}]}\n}]}';
  const f = fixture("You finish one exercise.", [{ type: "text", content: output }, { type: "done", content: "", stopReason: "stop" }]);
  const before = structuredClone(f.ctx.state);
  const result = await guardTurnOutput(f.ctx);
  assert.equal(result.audit?.outcome, "valid-updates");
  assert.equal(result.audit?.repaired, true);
  assert.equal(result.audit?.correctedBatch, output);
  assert.deepEqual(result.parsed.effects, [{ variableId: "energy-id", operation: "add", value: 1 }]);
  assert.equal(result.parsed.cleanText, "You finish one exercise.");
  assert.deepEqual(f.ctx.state, before);
  assert.equal(f.requests.length, 1);
  assert.equal(f.usages.length, 1);
});

test("trailing recovery composes with read-only exclusions", async () => {
  const f = readonlyFixture([{ variableId: "energy-id", operation: "add", value: 1 }, { variableId: "game-day", operation: "add", value: 0 }]);
  const output = f.output + '\n}]}';
  f.ctx.provider.generateStream = async function* (params) { f.requests.push(params); yield { type: "text", content: output }; yield { type: "done", content: "", stopReason: "stop" }; };
  const result = await guardTurnOutput(f.ctx);
  assert.deepEqual(result.parsed.effects, [{ variableId: "energy-id", operation: "add", value: 1 }]);
  assert.ok(result.audit?.diagnostics.includes("read_only_correction_ignored"));
  assert.equal(result.audit?.correctedBatch, output);
  assert.equal(f.ctx.state.variables["game-day"], 1);
});

test("trailing recovery does not bypass no-update review or unsafe-batch validation", async () => {
  for (const [body, expected] of [
    [{ narrative: "", status: "none", stateChanges: [] }, "missing_no_update_review"],
    [{ narrative: "", status: "updated", stateChanges: [{ variableId: "energy-id", operation: "add", value: 1 }, { variableId: "missing", operation: "set", value: 1 }] }, "unknown_variable"],
    [{ narrative: "", status: "updated", stateChanges: [{ variableId: "energy-id.__proto__.x", operation: "set", value: 1 }] }, "unsafe_path"],
    [{ narrative: "", status: "updated", stateChanges: [{ variableId: "energy-id", operation: "add", value: "bad" }] }, "incompatible_value"],
  ] as const) {
    const output = JSON.stringify(body) + '\n}]}';
    const f = fixture(undefined, [{ type: "text", content: output }, { type: "done", content: "", stopReason: "stop" }]);
    const before = structuredClone(f.ctx.state);
    await assert.rejects(guardTurnOutput(f.ctx), errorCode("invalid_correction"));
    assert.ok(f.ctx.audit.diagnostics.includes(expected));
    assert.deepEqual(f.ctx.state, before);
  }
  const f = fixture(undefined, [{ type: "text", content: reviewedNone + '\n}]}', }, { type: "done", content: "", stopReason: "stop" }]);
  assert.equal((await guardTurnOutput(f.ctx)).audit?.outcome, "explicit-none");
});

test("observed extra envelope closers are recovered without rewriting narrative or weakening batch validation", async () => {
  // Sanitized structural reproduction of the production failure, not user story content.
  const output = '{"narrative":"Unwanted rewrite.","status":"updated","stateChanges":[{"variableId":"energy-id","operation":"subtract","value":4}]}],"review":[]}';
  const f = fixture("You walk to the gate.", [{ type: "text", content: output }, { type: "done", content: "", stopReason: "stop" }]);
  const before = structuredClone(f.ctx.state);
  const result = await guardTurnOutput(f.ctx);
  assert.equal(result.audit?.outcome, "valid-updates");
  assert.equal(result.audit?.repaired, true);
  assert.equal(result.audit?.correctedBatch, output, "retain the exact provider output for investigation");
  assert.deepEqual(result.parsed.effects, [{ variableId: "energy-id", operation: "subtract", value: 4 }]);
  assert.equal(result.parsed.cleanText, "You walk to the gate.");
  assert.deepEqual(f.ctx.state, before);
  assert.equal(f.requests.length, 1);
  assert.equal(f.usages.length, 1);
});

for (const emitted of ["text", "reasoning", "usage", "tool_call_start"] as const) {
  test(`JSON-mode rejection after ${emitted} never starts a second generation`, async () => {
    const f = fixture();
    f.ctx.provider.generateStream = async function* (params) {
      f.requests.push(params);
      if (emitted === "usage") yield { type: "error", content: "response_format not supported", usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 } };
      else yield { type: emitted, content: emitted === "text" ? '{"narrative":' : "" };
      yield { type: "error", content: "response_format not supported" };
    };
    await assert.rejects(guardTurnOutput(f.ctx), errorCode("provider_unsupported_format"));
    assert.equal(f.requests.length, 1);
    assert.equal(f.usages.length, 1);
    assert.equal(f.ctx.state.variables["energy-id"], 100);
  });
}

test("format negotiation cannot loop or switch model when both requests fail", async () => {
  const f = fixture();
  f.ctx.provider.generateStream = async function* (params) {
    f.requests.push(params);
    yield { type: "error", content: "response_format is unsupported" };
  };
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("provider_unsupported_format"));
  assert.equal(f.requests.length, 2);
  assert.equal(f.usages.length, 1);
  assert.equal(f.requests[1]!.fallbackModels, undefined);
});

for (const mode of ["cancelled", "disabled"] as const) {
  test(`${mode} during format negotiation prevents another provider request`, async () => {
    const f = fixture();
    let checks = 0;
    f.ctx.mayCorrect = async () => {
      if (++checks === 1) return true;
      if (mode === "cancelled") f.controller.abort();
      return mode !== "disabled";
    };
    f.ctx.provider.generateStream = async function* (params) {
      f.requests.push(params);
      yield { type: "error", content: "response_format is unsupported" };
    };
    await assert.rejects(guardTurnOutput(f.ctx), errorCode(mode === "disabled" ? "disabled_or_stale" : "cancelled"));
    assert.equal(f.requests.length, 1);
    assert.equal(f.usages.length, 1);
  });
}

for (const [effect, code] of [
  [{ variableId: "unknown", operation: "set", value: 1 }, "unknown_variable"],
  [{ variableId: "energy-id", operation: "set", value: "one" }, "incompatible_value"],
  [{ variableId: "hidden", operation: "set", value: 1 }, "not_writable"],
  [{ variableId: "energy-id.__proto__.x", operation: "set", value: 1 }, "unsafe_path"],
] as const) {
  test(`syntax recovery still rejects ${code} without partial state changes`, async () => {
    const output = JSON.stringify({ narrative: "", status: "updated", stateChanges: [
      { variableId: "kills-id", operation: "add", value: 1 }, effect,
    ] }) + '],"review":[]}';
    const f = fixture(undefined, [{ type: "text", content: output }, { type: "done", content: "", stopReason: "stop" }]);
    f.ctx.world.variables.push({ id: "hidden", name: "Hidden", type: "number", defaultValue: 0, aiAccess: "none" });
    const before = structuredClone(f.ctx.state);
    await assert.rejects(guardTurnOutput(f.ctx), errorCode("invalid_correction"));
    assert.ok(f.ctx.audit.diagnostics.includes(code));
    assert.deepEqual(f.ctx.state, before);
    assert.equal(f.usages.length, 1);
    assert.equal(f.requests.length, 1, "no paid retry on malformed/unsafe generations");
  });
}

test("recovered explicit none still requires every writable variable's review", async () => {
  for (const complete of [true, false]) {
    const obj = JSON.parse(reviewedNone);
    const { review, ...rest } = obj;
    const output = JSON.stringify(rest) + '],"review":' + JSON.stringify(complete ? review : []) + '}';
    const f = fixture(undefined, [{ type: "text", content: output }, { type: "done", content: "", stopReason: "stop" }]);
    if (complete) assert.equal((await guardTurnOutput(f.ctx)).audit?.outcome, "explicit-none");
    else {
      await assert.rejects(guardTurnOutput(f.ctx), errorCode("invalid_correction"));
      assert.ok(f.ctx.audit.diagnostics.includes("missing_no_update_review"));
    }
    assert.equal(f.ctx.state.variables["energy-id"], 100);
  }
});

for (const stopReason of ["max_tokens", "content_filter"]) {
  test(`syntax recovery never accepts ${stopReason} output`, async () => {
    const output = '{"narrative":"","status":"updated","stateChanges":[{"variableId":"energy-id","operation":"subtract","value":4}]}],"review":[]}';
    const f = fixture(undefined, [{ type: "text", content: output }, { type: "done", content: "", stopReason }]);
    await assert.rejects(guardTurnOutput(f.ctx), errorCode("incomplete_correction"));
    assert.equal(f.ctx.state.variables["energy-id"], 100);
    assert.equal(f.requests.length, 1);
  });
}

test("correction preserves the original speaker without accepting a replacement speaker", async () => {
  const f = fixture("[speaker: Mia Chen]\nThe stranger waits.");
  const result = await guardTurnOutput(f.ctx);
  assert.equal(f.requests.length, 1);
  assert.equal(result.parsed.speaker, "Mia Chen");
  assert.equal(result.parsed.cleanText, "The stranger waits.");
});

test("a selected correction model is resolved lazily and its provider, limits and usage stay separate", async () => {
  const f = fixture();
  const requests: GenerateParams[] = [];
  f.ctx.stream = false; f.ctx.cacheEnabled = true;
  f.ctx.resolveCorrection = async () => ({ model: "other/correction", maxContext: 32_000, apiKeyTier: "regular", provider: {
    async *generateStream(params) { requests.push(params); yield { type: "text", content: reviewedNone }; yield { type: "done", content: "", stopReason: "stop", model: "other/served" }; },
    async listModels() { return []; },
  } });
  const result = await guardTurnOutput(f.ctx);
  assert.equal(f.requests.length, 0, "story provider must not run the correction");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.model, "other/correction");
  assert.equal(requests[0]!.stream, undefined);
  assert.equal(requests[0]!.cacheBreakpoints, undefined);
  assert.equal(result.audit?.model, "selected/provider-model", "story audit keeps its original model");
  assert.equal(result.audit?.correctionModel, "other/served");
  assert.equal(result.audit?.correctionApiKeyTier, "regular");
  assert.equal(f.usages[0]!.model, "other/served");
});

test("valid output never resolves even an unavailable selected correction model", async () => {
  const f = fixture(`The stranger waits.\n${none}`);
  f.ctx.resolveCorrection = async () => { throw new Error("must not resolve"); };
  assert.equal((await guardTurnOutput(f.ctx)).audit?.outcome, "explicit-none");
  assert.equal(f.usages.length, 0);
});

test("eight valid legacy commands keep the Grok story attribution without calling or billing the selected Gemini correction model", async () => {
  const f = fixture(`You reach the shelter.\n${Array.from({ length: 8 }, () => "[energy: -1]").join("\n")}\n${updated(8)}`);
  f.ctx.model = f.ctx.audit.model = "x-ai/grok-4.20";
  f.ctx.resolveCorrection = async () => { throw new Error("selected google/gemini-2.5-flash must not be called"); };
  const result = await guardTurnOutput(f.ctx);
  assert.equal(result.audit?.outcome, "valid-updates");
  assert.equal(result.audit?.parsedCount, 8);
  assert.equal(result.audit?.correctionCount, 0);
  assert.equal(result.audit?.model, "x-ai/grok-4.20");
  assert.equal(result.audit?.correctionModel, undefined);
  assert.equal(result.parsed.effects.length, 8);
  assert.equal(f.requests.length, 0);
  assert.equal(f.usages.length, 0);
});

test("the same model id on a separately resolved provider does not inherit story transport settings", async () => {
  const f = fixture();
  f.ctx.cacheEnabled = true; f.ctx.stream = false;
  const requests: GenerateParams[] = [];
  f.ctx.resolveCorrection = async () => ({ model: f.ctx.model, maxContext: 32_000, apiKeyTier: "byok", provider: {
    async *generateStream(params) { requests.push(params); yield { type: "text", content: reviewedNone }; yield { type: "done", content: "", stopReason: "stop" }; },
    async listModels() { return []; },
  } });
  await guardTurnOutput(f.ctx);
  assert.equal(requests[0]!.stream, undefined);
  assert.equal(requests[0]!.cacheBreakpoints, undefined);
  assert.equal(f.requests.length, 0);
});

test("unavailable selected model fails closed with no fallback or fabricated usage", async () => {
  const f = fixture();
  f.ctx.resolveCorrection = async () => { throw new StateGuardError("correction_model_unavailable"); };
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("correction_model_unavailable"));
  assert.equal(f.requests.length, 0); assert.equal(f.usages.length, 0);
});

test("selected correction model's smaller context limit is enforced before calling it", async () => {
  const f = fixture();
  f.ctx.resolveCorrection = async () => ({ provider: f.ctx.provider, model: "small/model", maxContext: 4096, apiKeyTier: "byok" });
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("correction_context_limit"));
  assert.equal(f.requests.length, 0); assert.equal(f.usages.length, 0);
});

test("cancellation during lazy model resolution cannot start a late provider request", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let resolving!: () => void;
  const started = new Promise<void>((resolve) => { resolving = resolve; });
  f.ctx.resolveCorrection = async () => { resolving(); await gate; return { provider: f.ctx.provider, model: "other/model", maxContext: 32_000, apiKeyTier: "byok" }; };
  const result = guardTurnOutput(f.ctx);
  await started; f.controller.abort();
  await assert.rejects(result, errorCode("cancelled"));
  release(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests.length, 0); assert.equal(f.usages.length, 0);
});

for (const [label, raw, outcome] of [
  ["valid commands", `The infected falls.\n[kills: add 1]\n${updated(1)}`, "valid-updates"],
  ["explicit none", `The stranger waits.\n${none}`, "explicit-none"],
  ["structured explicit none", '{"narrative":"The stranger waits.","status":"none","stateChanges":[]}', "explicit-none"],
] as const) {
  test(`${label} does not issue a correction request`, async () => {
    const f = fixture(raw);
    const before = structuredClone(f.ctx.state);
    const result = await guardTurnOutput(f.ctx);
    assert.equal(result.audit?.outcome, outcome);
    assert.equal(result.audit?.originalRaw, raw);
    assert.equal(result.audit?.originalRawTruncated, false);
    assert.deepEqual(result.audit?.variableNames, { "kills-id": "kills", "energy-id": "energy" });
    assert.equal(f.requests.length, 0);
    assert.equal(f.usages.length, 0);
    assert.deepEqual(f.ctx.state, before, "validation never mutates the live input snapshot");
    assert.ok(!result.parsed.cleanText.includes("yumina-state"));
  });
}

for (const path of ["send", "regenerate", "continue"] as const) {
  test(`${path}: empty JSON without a none flag requests correction`, async () => {
    const correction = reviewedNone;
    const f = fixture('{"narrative":"The stranger waits.","stateChanges":[]}', [
      { type: "text", content: correction }, { type: "done", content: "", stopReason: "stop" },
    ]);
    f.ctx.audit.path = path;
    f.ctx.world.settings.structuredOutput = true;
    const before = structuredClone(f.ctx.state);
    const result = await guardTurnOutput(f.ctx);
    assert.equal(f.requests.length, 1);
    assert.equal(result.audit?.initialOutcome, "invalid");
    assert.ok(result.audit?.diagnostics.includes("missing_receipt"));
    assert.equal(result.audit?.outcome, "explicit-none");
    assert.equal(result.audit?.originalRaw, f.ctx.raw, "save the pre-correction segment on every turn path");
    assert.equal(result.audit?.correctedBatch, correction);
    assert.equal(result.parsed.cleanText, "The stranger waits.");
    assert.deepEqual(result.parsed.effects, []);
    assert.deepEqual(f.ctx.state, before);
    const instructions = f.requests[0]!.messages[0]!.content as string;
    assert.ok(instructions.includes('"status":"none","stateChanges":[]'));
    assert.ok(instructions.includes("An empty stateChanges array or object alone is NOT a no-update acknowledgement"));
  });
}

for (const stateChanges of [[], {}]) {
  test(`correction cannot silently use empty ${JSON.stringify(stateChanges)} as none`, async () => {
    const f = fixture(undefined, [
      { type: "text", content: JSON.stringify({ narrative: "", stateChanges }) },
      { type: "done", content: "", stopReason: "stop" },
    ]);
    const before = structuredClone(f.ctx.state);
    await assert.rejects(guardTurnOutput(f.ctx), errorCode("invalid_correction"));
    assert.equal(f.requests.length, 1);
    assert.equal(f.usages.length, 1);
    assert.ok(f.ctx.audit.diagnostics.includes("missing_receipt"));
    assert.deepEqual(f.ctx.state, before);
  });
}

test("correction rejects none with commands instead of applying a contradictory batch", async () => {
  const f = fixture(undefined, [
    { type: "text", content: '{"narrative":"","status":"none","stateChanges":[{"variableId":"kills-id","operation":"add","value":1}]}' },
    { type: "done", content: "", stopReason: "stop" },
  ]);
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("invalid_correction"));
  assert.ok(f.ctx.audit.diagnostics.includes("contradictory_none"));
  assert.equal(f.ctx.state.variables["kills-id"], 0);
});

test("missing receipt issues exactly one same-model singleAttempt request and replaces the whole batch", async () => {
  const f = fixture("The infected falls.\n[kills: add 1]", [{ type: "text", content: `Unwanted rewrite.\n[kills: add 2]\n[energy: subtract 5]\n${updated(2)}` }, { type: "done", content: "", stopReason: "end_turn", model: "served-model", usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } }]);
  const result = await guardTurnOutput(f.ctx);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.model, f.ctx.model);
  assert.equal(f.requests[0]?.singleAttempt, true);
  assert.equal(f.requests[0]?.maxTokens, 4096);
  assert.equal(f.requests[0]?.fallbackModels, undefined);
  assert.equal(f.requests[0]?.tools, undefined);
  assert.equal(result.parsed.cleanText, "The infected falls.");
  assert.deepEqual(result.parsed.effects, [{ variableId: "kills-id", operation: "add", value: 2 }, { variableId: "energy-id", operation: "subtract", value: 5 }]);
  assert.deepEqual(f.progress, ["repairing"]);
  assert.deepEqual(f.usages, [{ model: "served-model", promptTokens: 20, completionTokens: 10, totalTokens: 30 }]);
  assert.deepEqual(result.audit?.usageLogIds, ["usage-1"]);
  assert.equal(result.audit?.correctionCount, 1);
});

test("correction can explicitly replace an incomplete command batch with none", async () => {
  const f = fixture("The stranger waits.\n[kills: add 1]");
  const result = await guardTurnOutput(f.ctx);
  assert.equal(result.audit?.outcome, "explicit-none");
  assert.deepEqual(result.parsed.effects, []);
});

test("correction cannot rewrite the original audio side effects", async () => {
  const f = fixture("Rain falls.\n[audio: rain play]", [{ type: "text", content: JSON.stringify({ ...JSON.parse(reviewedNone), narrative: "[audio: explosion play]" }) }, { type: "done", content: "" }]);
  const result = await guardTurnOutput(f.ctx);
  assert.equal(result.parsed.cleanText, "Rain falls.");
  assert.deepEqual(result.parsed.audioEffects, [{ trackId: "rain", action: "play" }]);
});

test("receipt-only output cannot masquerade as a delivered story", async () => {
  const f = fixture(none);
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("empty_story"));
  assert.equal(f.requests.length, 0);
});

test("state-only legacy UI output is valid without a segments variable", async () => {
  const f = fixture(`[kills: add 1]\n${updated(1)}`);
  assert.equal((await guardTurnOutput(f.ctx)).audit?.outcome, "valid-updates");
  assert.equal(f.requests.length, 0);
});

test("malformed state-only batch gets corrected before empty-content validation", async () => {
  const f = fixture("[kills: add]", [{ type: "text", content: `[kills: add 1]\n${updated(1)}` }, { type: "done", content: "" }]);
  assert.equal((await guardTurnOutput(f.ctx)).parsed.effects.length, 1);
  assert.equal(f.requests.length, 1);
});

test("state-only draft corrected to none is not charged as delivered content", async () => {
  const f = fixture("[kills: add]");
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("empty_story"));
  assert.equal(f.requests.length, 1);
});

test("correction preserves provider cache routing and non-streaming preference", async () => {
  const f = fixture(); f.ctx.cacheEnabled = true; f.ctx.stream = false;
  await guardTurnOutput(f.ctx);
  assert.deepEqual(f.requests[0]!.cacheBreakpoints, [0]);
  assert.equal(f.requests[0]!.stream, false);
});

test("narrative-only cards require neither acknowledgement nor correction", async () => {
  const f = fixture();
  f.ctx.world.variables = [];
  f.ctx.state = new GameStateManager(f.ctx.world).getSnapshot();
  assert.equal((await guardTurnOutput(f.ctx)).audit?.outcome, "not-required");
  assert.equal(f.requests.length, 0);
});

test("bounded history and frozen original draft are supplied as data", async () => {
  const f = fixture();
  f.ctx.history = Array.from({ length: 9 }, () => ({ role: "user", content: "The stranger waits. ".repeat(400) }));
  await guardTurnOutput(f.ctx);
  const data = JSON.parse(f.requests[0]!.messages[1]!.content as string);
  assert.equal(data.history.length, 4);
  assert.equal(data.history[0].content.length, 6000);
  assert.equal(data.draft, f.ctx.raw);
  assert.deepEqual(data.state, f.ctx.state.variables);
});

for (const [stopReason, code] of [["content_filter", "provider_refusal"], ["SAFETY", "provider_refusal"], ["max_tokens", "truncated_reply"], ["length", "truncated_reply"]]) {
  test(`initial ${stopReason} fails without correction`, async () => {
    const f = fixture(`Narrative.\n${none}`);
    f.ctx.stopReason = stopReason;
    await assert.rejects(guardTurnOutput(f.ctx), errorCode(code!));
    assert.equal(f.requests.length, 0);
  });
}

test("pre-cancelled request fails without provider work", async () => {
  const f = fixture(); f.controller.abort();
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("cancelled"));
  assert.equal(f.requests.length, 0);
});
test("disabled entitlement prevents correction", async () => {
  const f = fixture(); f.ctx.mayCorrect = async () => false;
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("disabled_or_stale"));
  assert.equal(f.requests.length, 0);
});
test("expired turn deadline prevents correction", async () => {
  const f = fixture(); f.ctx.audit.startedAt = new Date(Date.now() - 180_000).toISOString();
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("deadline"));
  assert.equal(f.requests.length, 0);
});
test("insufficient context fails instead of dropping schema or original draft", async () => {
  const f = fixture(); f.ctx.maxContext = 4608;
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("correction_context_limit"));
  assert.equal(f.requests.length, 0);
});

for (const [label, chunks, code] of [
  ["invalid correction", [{ type: "text", content: "Still only prose." }, { type: "done", content: "" }], "invalid_correction"],
  ["missing terminal chunk", [{ type: "text", content: none }], "incomplete_correction"],
  ["truncated correction", [{ type: "text", content: none }, { type: "done", content: "", stopReason: "max_tokens" }], "incomplete_correction"],
  ["refused correction", [{ type: "text", content: none }, { type: "done", content: "", stopReason: "content_filter" }], "incomplete_correction"],
  ["provider error chunk", [{ type: "error", content: "private upstream detail" }], "provider_error"],
  ["overlong correction", [{ type: "text", content: "x".repeat(65537) }], "correction_output_limit"],
] as Array<[string, StreamChunk[], string]>) {
  test(`${label} fails closed after one request with usage accounted`, async () => {
    const f = fixture(undefined, chunks);
    await assert.rejects(guardTurnOutput(f.ctx), errorCode(code));
    assert.equal(f.requests.length, 1);
    assert.equal(f.usages.length, 1);
    assert.equal(f.ctx.audit.correctionCount, 1);
    assert.equal(f.ctx.audit.originalRaw, f.ctx.raw, "failed correction still retains the original reply");
    assert.deepEqual(f.ctx.audit.variableNames, { "kills-id": "kills", "energy-id": "energy" });
    assert.equal(f.ctx.state.variables["kills-id"], 0);
  });
}

test("thrown upstream errors are sanitized and logged once", async () => {
  const f = fixture();
  f.ctx.provider.generateStream = async function* () { throw new Error("private provider body"); };
  await assert.rejects(guardTurnOutput(f.ctx), (error: unknown) => errorCode("provider_error")(error) && !(error as Error).message.includes("private"));
  assert.equal(f.usages.length, 1);
});

test("original audit preview is bounded without shortening the actual draft or changing saved labels later", async () => {
  const raw = `The stranger waits. ${"x".repeat(65536)}\n${none}`;
  const f = fixture(raw);
  f.ctx.world.variables[0]!.name = "K".repeat(201);
  const result = await guardTurnOutput(f.ctx);
  assert.equal(result.audit?.originalRaw, raw.slice(0, 65536));
  assert.equal(result.audit?.originalRawTruncated, true);
  assert.equal(f.ctx.raw, raw);
  assert.equal(result.audit?.variableNames?.["kills-id"], "K".repeat(200));
  f.ctx.world.variables[0]!.name = "Renamed after the call";
  assert.equal(result.audit?.variableNames?.["kills-id"], "K".repeat(200));
});

test("early failures retain an original audit with a bounded variable-name catalog", async () => {
  const f = fixture(`The stranger waits.\n${none}`);
  f.ctx.world.variables = Array.from({ length: 1001 }, (_, index) => ({ id: `v-${index}`, name: `Variable ${index}`, type: "number", defaultValue: 0 }));
  f.controller.abort();
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("cancelled"));
  assert.equal(f.ctx.audit.originalRaw, f.ctx.raw);
  assert.equal(f.ctx.audit.originalRawTruncated, false);
  assert.equal(Object.keys(f.ctx.audit.variableNames!).length, 1000);
  assert.equal(f.ctx.audit.variableNames?.["v-999"], "Variable 999");
  assert.equal(f.ctx.audit.variableNames?.["v-1000"], undefined);
  assert.equal(f.requests.length, 0);
});
test("user cancellation bounds even a provider that ignores its AbortSignal", async () => {
  const f = fixture();
  f.ctx.provider.generateStream = async function* () { f.controller.abort(); await new Promise(() => {}); };
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("cancelled"));
  assert.equal(f.usages.length, 1);
});

test("cancellation during asynchronous usage persistence cannot return a valid batch", async () => {
  const f = fixture();
  f.ctx.recordUsage = async () => { f.controller.abort(); return "usage-cancelled"; };
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("cancelled"));
  assert.deepEqual(f.ctx.audit.usageLogIds, ["usage-cancelled"]);
});

test("remaining turn deadline bounds a non-cooperative provider", { timeout: 6000 }, async () => {
  const f = fixture();
  f.ctx.audit.startedAt = new Date(Date.now() - 178_000).toISOString();
  f.ctx.provider.generateStream = async function* () { await new Promise(() => {}); };
  const start = Date.now();
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("correction_timeout"));
  assert.ok(Date.now() - start < 5000);
  assert.equal(f.usages.length, 1);
});

test("malformed structured output freezes only its complete narrative field", async () => {
  const f = fixture('{"narrative":"The stranger waits.","stateChanges":[{"variableId":"kills-id","operation":"add",');
  const result = await guardTurnOutput(f.ctx);
  assert.equal(result.parsed.cleanText, "The stranger waits.");
  assert.deepEqual(result.parsed.effects, []);
  assert.ok(!result.parsed.cleanText.includes("stateChanges"));
});

test("giant unbroken correction input is rejected quickly before tokenization", { timeout: 3000 }, async () => {
  const f = fixture("x".repeat(100_000));
  const start = Date.now();
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("correction_context_limit"));
  assert.ok(Date.now() - start < 1000);
  assert.equal(f.requests.length, 0);
});

test("bounded token estimate uses conservative UTF-8 bytes for pathological pieces", () => {
  const text = "界".repeat(1000);
  assert.equal(boundedCorrectionInputTokens(text, "selected/model"), Buffer.byteLength(text, "utf8"));
  assert.equal(estimateCorrectionUsageTokens("x".repeat(65537)), 16385);
});

test("a bare none correction cannot silently discard missing state updates", async () => {
  const f = fixture("You sprint into the alley.", [{ type: "text", content: none }, { type: "done", content: "", stopReason: "stop" }]);
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("invalid_correction"));
  assert.ok(f.ctx.audit.diagnostics.includes("missing_no_update_review"));
  assert.equal(f.ctx.audit.correctedBatch, none);
});

for (const review of [null, {}, [], [{ variableId: "kills-id", reason: "No kill." }],
  [{ variableId: "kills-id", reason: "No kill." }, { variableId: "unknown", reason: "No event." }],
  [{ variableId: "kills-id", reason: "No kill." }, { variableId: "kills-id", reason: "Duplicate." }],
  [{ variableId: "kills-id", reason: "No kill." }, { variableId: "energy-id", reason: " " }]]) {
  test(`none correction requires a complete nonempty variable review: ${JSON.stringify(review)}`, async () => {
    const output = JSON.stringify({ ...JSON.parse(reviewedNone), review });
    const f = fixture(undefined, [{ type: "text", content: output }, { type: "done", content: "" }]);
    await assert.rejects(guardTurnOutput(f.ctx), errorCode("invalid_correction"));
    assert.equal(f.ctx.audit.correctedBatch, output);
  });
}

test("invalid correction text is retained before validation, without applying state", async () => {
  const output = `${updated(2)}\n[kills: add 1]`;
  const f = fixture(undefined, [{ type: "text", content: output }, { type: "done", content: "", stopReason: "stop" }]);
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("invalid_correction"));
  assert.equal(f.ctx.audit.correctedBatch, output);
  assert.equal(f.ctx.state.variables["kills-id"], 0);
});

test("correction gives complete operation examples and separates writable from hidden variables", async () => {
  const f = fixture();
  f.ctx.world.variables.push({ id: "secret", name: "secret", type: "number", defaultValue: 7, internal: true });
  f.ctx.state.variables.secret = 7;
  f.ctx.world.variables[1]!.behaviorRules = "Running costs energy.";
  await guardTurnOutput(f.ctx);
  const request = f.requests[0]!;
  const data = JSON.parse(request.messages[1]!.content as string);
  assert.deepEqual(data.writableVariableIds, ["kills-id", "energy-id"]);
  assert.ok(!data.variables.some((v: { id: string }) => v.id === "secret"));
  assert.equal(data.state.secret, undefined);
  assert.equal(data.variables[1].behaviorRules, "Running costs energy.");
  const prompt = request.messages[0]!.content as string;
  assert.ok(prompt.includes('"variableId":"energy-id","operation":"subtract","value":2'));
  assert.ok(prompt.includes("behaviorRules"));
  assert.ok(prompt.includes("An empty stateChanges array or object alone is NOT a no-update acknowledgement"));
});

test("none review covers only currently writable variables; read-only values remain context", async () => {
  const output = JSON.stringify({ ...JSON.parse(reviewedNone), review: [{ variableId: "kills-id", reason: "No kill." }] });
  const f = fixture(undefined, [{ type: "text", content: output }, { type: "done", content: "" }]);
  f.ctx.world.variables[1]!.aiAccess = "read";
  f.ctx.world.variables.push({ id: "disabled", name: "disabled", type: "number", defaultValue: 4, enabled: false });
  f.ctx.state.variables.disabled = 4;
  const result = await guardTurnOutput(f.ctx);
  assert.equal(result.audit?.outcome, "explicit-none");
  const data = JSON.parse(f.requests[0]!.messages[1]!.content as string);
  assert.deepEqual(data.writableVariableIds, ["kills-id"]);
  assert.equal(data.state["energy-id"], 100);
  assert.equal(data.state.disabled, undefined);
});

test("audit bounds truncated correction text and never retains provider error bodies", async () => {
  const f = fixture(undefined, [{ type: "text", content: "x".repeat(70000) }]);
  await assert.rejects(guardTurnOutput(f.ctx), errorCode("correction_output_limit"));
  assert.equal(f.ctx.audit.correctedBatch?.length, 65536);
  const g = fixture(undefined, [{ type: "text", content: "partial" }, { type: "error", content: "private-provider-response" }]);
  await assert.rejects(guardTurnOutput(g.ctx), errorCode("provider_error"));
  assert.equal(g.ctx.audit.correctedBatch, "partial");
});

for (const path of ["send", "regenerate", "continue"] as const) {
  test(`${path}: running/waiting repair changes engine values without replaying old kills`, async () => {
    const raw = "You run into the residential street, then wait thirty minutes.";
    const batch = JSON.stringify({ narrative: "", status: "updated", stateChanges: [
      { variableId: "time-id", operation: "set", value: "09:10 AM" },
      { variableId: "energy-id", operation: "subtract", value: 4 },
      { variableId: "location-id", operation: "set", value: "Residential street" },
    ] });
    const f = fixture(raw, [{ type: "text", content: batch }, { type: "done", content: "", stopReason: "stop" }]);
    f.ctx.audit.path = path;
    f.ctx.world.variables.push(
      { id: "time-id", name: "time", type: "string", defaultValue: "08:35 AM", behaviorRules: "Time progresses naturally with actions. Never move backward." },
      { id: "location-id", name: "location", type: "string", defaultValue: "Mall", behaviorRules: "Update when entering a new meaningful area." },
    );
    f.ctx.world.variables[1]!.behaviorRules = "Running costs twice as much energy as walking.";
    f.ctx.state = new GameStateManager(f.ctx.world).getSnapshot();
    const before = structuredClone(f.ctx.state);
    const result = await guardTurnOutput(f.ctx);
    const engine = new GameStateManager(f.ctx.world, structuredClone(f.ctx.state));
    engine.applyEffects(result.parsed.effects);
    assert.equal(engine.get("time-id"), "09:10 AM");
    assert.equal(engine.get("energy-id"), 96);
    assert.equal(engine.get("location-id"), "Residential street");
    assert.equal(engine.get("kills-id"), 0);
    assert.equal(result.parsed.cleanText, raw);
    assert.deepEqual(f.ctx.state, before);
  });
}
