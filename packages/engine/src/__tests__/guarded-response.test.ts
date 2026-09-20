import { describe, expect, it } from "vitest";
import { parseGuardedResponse, validateAiBatch } from "../parser/guarded-response.js";
import { ResponseParser } from "../parser/response-parser.js";
import { GameStateManager } from "../state/game-state-manager.js";
import type { Effect, Variable } from "../types/index.js";
import { createMockGameState, createMockVariable, createMockWorld } from "./test-utils.js";

const none = '<yumina-state version="1" status="none" />';
const updated = (count: number) => `<yumina-state version="1" status="updated" count="${count}" />`;
describe("main engine JSON write protection", () => {
  it("keeps leading speaker metadata out of the state command count", () => {
    const result = fixture().parse(`[speaker: Mia Chen]\nShe smiles. [health: subtract 1]\n${updated(1)}`);
    expect(result).toMatchObject({ outcome: "valid-updates", speaker: "Mia Chen", cleanText: "She smiles." });
    expect(result.effects).toHaveLength(1);
  });
  it("preserves speaker metadata when relocating a terminal receipt", () => {
    const result = fixture().parse(`[speaker: Mia Chen]\nShe smiles.\n${updated(1)}\n[health: subtract 1]`);
    expect(result).toMatchObject({ outcome: "valid-updates", speaker: "Mia Chen", repaired: true });
  });
  it.each(["delete 0", 42, true])("rejects refused container overwrite %s before accepting a batch", (value) => {
    const world = createMockWorld({ variables: [createMockVariable({ id: "items", name: "items", type: "json", defaultValue: ["rope"] })] });
    const state = new GameStateManager(world).getSnapshot();
    const result = parseGuardedResponse(JSON.stringify({ narrative: "Story.", status: "updated", stateChanges: [{ variableId: "items", operation: "set", value }] }), world, state);
    expect(result.outcome).toBe("invalid");
    expect(result.effects).toEqual([]);
    expect(result.diagnostics).toContainEqual({ code: "incompatible_value" });
    expect(state.variables.items).toEqual(["rope"]);
  });
  it("keeps main's quoted JSON coercion", () => {
    const world = createMockWorld({ variables: [createMockVariable({ id: "items", name: "items", type: "json", defaultValue: ["rope"] })] });
    const engine = new GameStateManager(world);
    const result = validateAiBatch(world, engine.getSnapshot(), [{ variableId: "items", operation: "set", value: '["rope","water"]' }]);
    expect(result.diagnostics).toEqual([]);
    engine.applyEffects(result.effects);
    expect(engine.get("items")).toEqual(["rope", "water"]);
  });
});
function fixture(extra: Partial<Variable>[] = []) {
  const variables = [
    createMockVariable({ id: "hp-id", name: "health", defaultValue: 100, min: 0, max: 100 }),
    createMockVariable({ id: "energy", name: "体力", defaultValue: 50 }),
    createMockVariable({ id: "kills", name: "zombieKills", defaultValue: 0 }),
    createMockVariable({ id: "place", name: "location", type: "string", defaultValue: "Street" }),
    createMockVariable({ id: "key", name: "hasKey", type: "boolean", defaultValue: false }),
    createMockVariable({ id: "bag", name: "game_state", type: "json", defaultValue: { count: 1, items: [], nested: { hp: 2, alive: true, text: "a" } } }),
    createMockVariable({ id: "list", name: "inventory", type: "json", defaultValue: [] }),
    ...extra.map((v) => createMockVariable(v)),
  ];
  const world = createMockWorld({ variables });
  const state = createMockGameState({ fromVariables: variables });
  return { world, state, parse: (raw: string) => parseGuardedResponse(raw, world, state) };
}
const codes = (r: ReturnType<typeof parseGuardedResponse>) => r.diagnostics.map((d) => d.code);

describe("State Update Guard acknowledgement", () => {
  it("requires explicit none, rather than interpreting absent commands as success", () => {
    const { parse } = fixture();
    expect(parse(`The stranger waits.\n${none}`)).toMatchObject({ outcome: "explicit-none", effects: [], cleanText: "The stranger waits." });
    expect(codes(parse("The stranger waits."))).toContain("missing_receipt");
  });
  it.each([
    ['<yumina-state version="2" status="none" />', "invalid_receipt"],
    ['<yumina-state version="1" status="none" count="0" />', "invalid_receipt"],
    ['<yumina-state version="1" status="unknown" />', "invalid_receipt"],
    ['<yumina-state version="1" status="none" extra="yes" />', "invalid_receipt"],
    ['<yumina-state version="1" status="updated" />', "invalid_receipt"],
    ['<yumina-state version="1" status="updated" count="01" />', "invalid_receipt"],
    ['<yumina-state version="1" status="none"', "invalid_receipt"],
    [`${none}\n${none}`, "duplicate_receipt"],
    [`${none}\nMore narrative.`, "nonterminal_receipt"],
    [`> ${none}`, "missing_receipt"],
    [`"${none}"`, "missing_receipt"],
    [`\\${none}`, "missing_receipt"],
    [`\`\`\`text\n${none}\n\`\`\``, "missing_receipt"],
    [`~~~text\n${none}\n~~~`, "missing_receipt"],
    [`[health: add 1]\n${none}`, "contradictory_none"],
    [updated(0), "count_mismatch"],
    [`[health: add 1]\n${updated(2)}`, "count_mismatch"],
  ])("rejects %s", (raw, code) => {
    const result = fixture().parse(raw);
    expect(result.outcome).toBe("invalid");
    expect(result.effects).toEqual([]);
    expect(codes(result)).toContain(code);
  });
  it("accepts harmless whitespace and CRLF", () => {
    expect(fixture().parse(`Story.\r\n\t ${none}  \r\n\r\n`).outcome).toBe("explicit-none");
  });
  it("does not count audio as state updates", () => {
    const result = fixture().parse(`Story.\n[audio: rain play]\n${none}`);
    expect(result.outcome).toBe("explicit-none");
    expect(result.audioEffects).toEqual([{ trackId: "rain", action: "play" }]);
    expect(result.effects).toEqual([]);
  });
  it("does not require acknowledgement for a narrative-only card", () => {
    expect(parseGuardedResponse("Story.", createMockWorld(), createMockGameState()).outcome).toBe("not-required");
  });
  it("still rejects rogue writes when no writable state exists", () => {
    const result = parseGuardedResponse(`[ghost: add 1]\n${updated(1)}`, createMockWorld(), createMockGameState());
    expect(result.outcome).toBe("invalid");
    expect(codes(result)).toContain("unknown_variable");
  });
  it("ignores receipts contained in model thinking", () => {
    const result = fixture().parse(`<think>${none}</think>\nStory.\n${none}`);
    expect(result.outcome).toBe("explicit-none");
  });
});

describe("supported legacy commands", () => {
  it.each([
    '[health: set 50]', '[health: +5]', '[health: -5]', '[health: *2]', '[health: 50]',
    '[health: add 2]', '[health: subtract 2]', '[health: multiply 2]', '[体力: subtract 2]',
    '[hp-id: set 100]', '[location: set "Stockroom"]', '[location: set Stockroom]',
    '[location: forest]',
    '[location: append " door"]', '[hasKey: toggle]', '[hasKey: set true]', '[hasKey: false]',
    '[bag: merge {"new":1}]', '[inventory: push {"name":"rope","tags":[]}]',
    '[inventory: push "rope"]', '[bag: delete "count"]', '[inventory: delete 0]',
    '[bag.nested.hp: add 1]', '[bag.nested.hp: set 4]', '[bag: set {"items":[{"name":"a]b"}]}]',
  ])("preserves existing normalized effects: %s", (raw) => {
    const { parse } = fixture();
    const result = parse(`Story.\n${raw}\n${updated(1)}`);
    expect(result.outcome).toBe("valid-updates");
    const legacy = new ResponseParser().parse(raw);
    expect(result.effects.map(({ operation, value }) => ({ operation, value }))).toEqual(legacy.effects.map(({ operation, value }) => ({ operation, value })));
    expect(result.cleanText).toBe("Story.");
  });
  it("normalizes aliases to persistent IDs", () => {
    expect(fixture().parse(`[health: subtract 1]\n${updated(1)}`).effects[0]?.variableId).toBe("hp-id");
  });
  it("counts operations rather than distinct variables or actual deltas", () => {
    const { parse, state, world } = fixture();
    const result = parse(`[health: set 100]\n[health: set 100]\n${updated(2)}`);
    expect(result.outcome).toBe("valid-updates");
    expect(result.effects).toHaveLength(2);
    expect(new GameStateManager(world, state).applyEffects(result.effects)).toEqual([]);
  });
  it("keeps legacy clamping", () => {
    const { parse, state, world } = fixture();
    const result = parse(`[health: add 1000]\n${updated(1)}`);
    expect(result.outcome).toBe("valid-updates");
    const engine = new GameStateManager(world, state);
    engine.applyEffects(result.effects);
    expect(engine.get("hp-id")).toBe(100);
  });
  it("accepts sequential container creation and bracket-index access without mutating input", () => {
    const { parse, state } = fixture();
    const baseline = structuredClone(state);
    const result = parse(`[bag: set {"items":[{"hp":3}]}]\n[bag.items[0].hp: subtract 1]\n${updated(2)}`);
    expect(result.outcome).toBe("valid-updates");
    expect(result.effects[1]).toMatchObject({ variableId: "bag.items.0.hp", operation: "subtract", value: 1 });
    expect(state).toEqual(baseline);
  });
  it("normalizes nested operations using the private sequential state", () => {
    const { parse } = fixture();
    const result = parse(`[bag.nested.hp: multiply 3]\n[bag.nested.alive: toggle]\n[bag.nested.text: append "b"]\n${updated(3)}`);
    expect(result.effects).toEqual([
      { variableId: "bag.nested.hp", operation: "set", value: 6 },
      { variableId: "bag.nested.alive", operation: "set", value: false },
      { variableId: "bag.nested.text", operation: "set", value: "ab" },
    ]);
  });
});

describe("safe repair and complete batch validation", () => {
  it("recovers the observed receipt-first failure without losing the update", () => {
    const result = fixture().parse(`${updated(1)}\n[location: set "Alley"]`);
    expect(result).toMatchObject({ outcome: "valid-updates", repaired: true, cleanText: "" });
    expect(result.effects).toEqual([{ variableId: "place", operation: "set", value: "Alley" }]);
  });
  it("validates a relocated JSON tail against containers created by preceding commands", () => {
    const result = fixture().parse(`[bag: set {"newItems":[]}]\n${updated(2)}\n[bag.newItems: push "rope"]`);
    expect(result.outcome).toBe("valid-updates");
    expect(result.repaired).toBe(true);
    expect(result.effects).toEqual([
      { variableId: "bag", operation: "set", value: { newItems: [] } },
      { variableId: "bag.newItems", operation: "push", value: "rope" },
    ]);
  });
  it("preserves narrative after a misplaced marker when correction is required", () => {
    const result = fixture().parse(`${updated(1)}\nYou enter the alley.\n[location: set "Alley"]`);
    expect(result.outcome).toBe("invalid");
    expect(result.effects).toEqual([]);
    expect(result.cleanText).toBe("You enter the alley.");
    expect(codes(result)).toContain("nonterminal_receipt");
  });
  it("relocates one updated receipt only across a complete command-only tail", () => {
    const result = fixture().parse(`You run.\n[energy: subtract 2]\n${updated(2)}\n[location: set "Alley"]`);
    expect(result.outcome).toBe("valid-updates");
    expect(result.repaired).toBe(true);
    expect(result.cleanText).toBe("You run.");
    expect(result.effects).toHaveLength(2);
  });
  it.each([
    `${updated(1)}\nMore story.\n[health: set 80]`,
    `${updated(2)}\n[health: set 80]`,
    `${updated(1)}\n[health: set nope]`,
    `${updated(1)}\n[ghost: set 80]`,
    `${updated(1)}\n[health: set 80]\n${updated(1)}`,
    `${none}\n[health: set 80]`,
  ])("does not relocate an ambiguous or invalid receipt: %s", (raw) => {
    expect(fixture().parse(raw).outcome).toBe("invalid");
    expect(fixture().parse(raw).effects).toEqual([]);
  });
  it.each(['[health: add 1', '[hasKey: toggle', '[location: set "Stockroom"', '[bag: set {"nested":[1,2]}'])
    ("repairs only missing outer closer: %s", (raw) => {
      const result = fixture().parse(`${raw}\n${updated(1)}`);
      expect(result.outcome).toBe("valid-updates");
      expect(result.repaired).toBe(true);
    });
  it.each(['[health: add', '[health: add 1e', '[location: set Stockroom', '[location: set "Stockroom', '[bag: set {"nested":[1,2]', '[bag: merge {"nested":1,}]', '[health: explode 4]'])
    ("does not invent missing or invalid payload: %s", (raw) => {
      const result = fixture().parse(`${raw}\n${none}`);
      expect(result.outcome).toBe("invalid");
      expect(result.effects).toEqual([]);
    });
  it("repairs a first missing bracket without swallowing the following command", () => {
    const result = fixture().parse(`[health: subtract 1\n[energy: subtract 2]\n${updated(2)}`);
    expect(result.outcome).toBe("valid-updates");
    expect(result.effects).toHaveLength(2);
  });
  it("rejects the whole batch when a malformed first member precedes a valid second", () => {
    const { parse, state } = fixture();
    const baseline = structuredClone(state);
    const result = parse(`[health: add nope]\n[energy: subtract 2]\n${updated(2)}`);
    expect(result.outcome).toBe("invalid");
    expect(result.effects).toEqual([]);
    expect(state).toEqual(baseline);
  });
  it("does not accept none when a known-variable command is missing its colon", () => {
    expect(fixture().parse(`[health subtract 1]\n${none}`).outcome).toBe("invalid");
  });
});

describe("structured and compatibility adapters", () => {
  it.each([{ stateChanges: [] }, { stateChanges: {} }])("requires a designated none flag for empty stateChanges %j", ({ stateChanges }) => {
    const { parse } = fixture();
    const missingFlag = parse(JSON.stringify({ narrative: "Story.", stateChanges }));
    expect(missingFlag).toMatchObject({ outcome: "invalid", effects: [] });
    expect(codes(missingFlag)).toContain("missing_receipt");
    for (const fenced of [false, true]) {
      const raw = JSON.stringify({ narrative: "Story.", status: "none", stateChanges });
      expect(parse(fenced ? `\`\`\`json\n${raw}\n\`\`\`` : raw)).toMatchObject({
        outcome: "explicit-none", effects: [], cleanText: "Story.", declaredCount: 0,
      });
    }
  });
  it.each([null, false, 0, "", "NONE", "no_updates", {}, []].map((status) => ({ status })))("rejects invalid JSON status %j", ({ status }) => {
    const result = fixture().parse(JSON.stringify({ narrative: "Story.", status, stateChanges: [] }));
    expect(result).toMatchObject({ outcome: "invalid", effects: [] });
    expect(codes(result)).toContain("invalid_receipt");
  });
  it.each([[], {}].map((stateChanges) => ({ stateChanges })))("rejects updated status with an empty batch %j", ({ stateChanges }) => {
    expect(codes(fixture().parse(JSON.stringify({ narrative: "Story.", status: "updated", stateChanges })))).toContain("count_mismatch");
  });
  it.each([{ stateChanges: [{ variableId: "health", operation: "set", value: 50 }] }, { stateChanges: { health: 50 } }])
    ("rejects none alongside updates without mutating state %j", ({ stateChanges }) => {
      const { parse, state } = fixture();
      const baseline = structuredClone(state);
      expect(parse(JSON.stringify({ narrative: "Story.", status: "none", stateChanges }))).toMatchObject({
        outcome: "invalid", effects: [], diagnostics: [{ code: "contradictory_none" }],
      });
      expect(state).toEqual(baseline);
      expect(parse(JSON.stringify({ narrative: "Story.", status: "updated", stateChanges })).outcome).toBe("valid-updates");
    });
  it.each([undefined, null, "none", [null], [{}]].map((stateChanges) => ({ stateChanges })))("none does not excuse missing or invalid batch %j", ({ stateChanges }) => {
    expect(fixture().parse(JSON.stringify({ narrative: "Story.", status: "none", stateChanges })).outcome).toBe("invalid");
  });
  it("does not accept a no-update flag quoted in narrative or nested metadata", () => {
    expect(fixture().parse(JSON.stringify({ narrative: 'The sign reads status: "none".', metadata: { status: "none" }, stateChanges: [] })).outcome).toBe("invalid");
  });
  it("requires the same flag when structured output is configured on the card", () => {
    const { world, state } = fixture();
    world.settings.structuredOutput = true;
    expect(parseGuardedResponse('{"narrative":"Story.","stateChanges":[]}', world, state).outcome).toBe("invalid");
    expect(parseGuardedResponse('{"narrative":"Story.","status":"none","stateChanges":[]}', world, state).outcome).toBe("explicit-none");
  });
  it("does not impose a state acknowledgement on a card without writable variables", () => {
    expect(parseGuardedResponse('{"narrative":"Story.","stateChanges":[]}', createMockWorld(), createMockGameState()).outcome).toBe("not-required");
  });
  it.each([undefined, null, "none", 0, true, [null], [{}], [{ variableId: "health", operation: "set" }], [{ variableId: "health", operation: "explode", value: 1 }]].map((stateChanges) => ({ stateChanges })))
    ("rejects missing/invalid stateChanges %j", ({ stateChanges }) => {
      expect(fixture().parse(JSON.stringify({ narrative: "Story.", stateChanges })).outcome).toBe("invalid");
    });
  it("supports complete arrays, maps and fenced structured envelopes", () => {
    for (const stateChanges of [[{ variableId: "health", operation: "set", value: 50 }], { health: 50 }]) {
      const raw = JSON.stringify({ narrative: "Story.", stateChanges });
      for (const wrapped of [raw, `\`\`\`json\n${raw}\n\`\`\``]) {
        expect(fixture().parse(wrapped)).toMatchObject({ outcome: "valid-updates", effects: [{ variableId: "hp-id", operation: "set", value: 50 }] });
      }
    }
  });
  it.each(['{"narrative":"Story.","stateChanges":[', '{"narrative":"Story.","stateChanges":[{"variableId":"health","operation":"set","value":', '{"narrative":"Story.","stateChanges":[],"unfinished":"'])
    ("never turns truncated JSON into explicit none: %s", (raw) => expect(fixture().parse(raw).outcome).toBe("invalid"));
  it("rejects invalid member without keeping a valid sibling", () => {
    expect(fixture().parse(JSON.stringify({ narrative: "Story.", stateChanges: [{ variableId: "health", operation: "set", value: 50 }, null] })).effects).toEqual([]);
  });
  it("supports fenced command maps", () => {
    const result = fixture().parse(`Story.\n\`\`\`json\n[{"health":"subtract 1"},{"energy":"-2"}]\n\`\`\`\n${updated(2)}`);
    expect(result.outcome).toBe("valid-updates");
    expect(result.effects).toHaveLength(2);
  });
  it("does not silently drop a malformed fenced member", () => {
    expect(fixture().parse(`\`\`\`json\n[{"health":"subtract 1"},{"energy":null}]\n\`\`\`\n${none}`).outcome).toBe("invalid");
  });
  it("does not treat a malformed shorthand fence as explicit none", () => {
    expect(fixture().parse(`\`\`\`json\n[{"health":"-1"},{"energy":null}]\n\`\`\`\n${none}`).outcome).toBe("invalid");
  });
  it("rejects a fenced inline mixed batch rather than silently accepting only its valid command", () => {
    const result = fixture().parse(`Story.\n\`\`\`text\n[health: subtract 1]\n[bag: merge {"missing":1,}]\n\`\`\`\n${updated(1)}`);
    expect(result.outcome).toBe("invalid");
    expect(result.effects).toEqual([]);
    expect(codes(result)).toContain("malformed_directive");
  });
  it.each([
    '{"narrative":"The survivor waits.","stateChanges":[',
    '{"narrative":"The survivor waits.","stateChanges":[{"variableId":"health","operation":"set","value":',
    '```json\n{"narrative":"The survivor waits.","stateChanges":[\n```',
  ])("retains only complete narrative from malformed structured output: %s", (raw) => {
    const result = fixture().parse(raw);
    expect(result).toMatchObject({ outcome: "invalid", cleanText: "The survivor waits.", effects: [], audioEffects: [] });
    expect(codes(result)).toContain("incomplete_json");
  });
  it.each([
    String.raw`{"narrative":"Bad\qescape","stateChanges":[`,
    String.raw`{"narrative":"Bad\u12escape","stateChanges":[`,
  ])("invalid narrative escape cannot throw during display-only recovery: %s", (raw) => {
    const { parse } = fixture();
    expect(() => parse(raw)).not.toThrow();
    expect(parse(raw)).toMatchObject({ outcome: "invalid", cleanText: "", effects: [] });
  });
  it("supports JSONPatch replace/delta/insert/remove in the existing root", () => {
    const patches = [{ op: "replace", path: "/count", value: 4 }, { op: "delta", path: "/count", value: -1 }, { op: "insert", path: "/new", value: true }, { op: "remove", path: "/new" }];
    const result = fixture().parse(`<UpdateVariable><JSONPatch>${JSON.stringify(patches)}</JSONPatch></UpdateVariable>\n${updated(4)}`);
    expect(result.outcome).toBe("valid-updates");
    expect(result.effects.map((e) => e.variableId)).toEqual(["bag.count", "bag.count", "bag.new", "bag.new"]);
  });
  it.each(['[{"op":"copy","path":"/count","value":1}]', '[{"op":"replace","path":"/count"}]', '[{"op":"delta","path":"/count","value":"oops"}]', '[{"op":"replace","path":"/constructor","value":1}]'])
    ("rejects invalid JSONPatch %s", (patch) => expect(fixture().parse(`<UpdateVariable><JSONPatch>${patch}</JSONPatch></UpdateVariable>\n${updated(1)}`).outcome).toBe("invalid"));
});

describe("sanitized missing-update regressions", () => {
  it.each([
    "You bring down the infected and run toward the supply store.",
    "A distant announcement confirms another contestant has died. Thirty-seven remain.",
  ])("detects absent protocol despite fluent narration: %s", (raw) => {
    const result = fixture().parse(raw);
    expect(result.outcome).toBe("invalid");
    expect(codes(result)).toContain("missing_receipt");
  });
  it("does not claim semantic guarantees for a well-formed but wrong-none assertion", () => {
    expect(fixture().parse(`You kill the infected.\n${none}`).outcome).toBe("explicit-none");
  });
  it("does not claim to detect a semantically omitted effect in a complete batch", () => {
    expect(fixture().parse(`You kill the infected and spend energy.\n[energy: subtract 2]\n${updated(1)}`).outcome).toBe("valid-updates");
  });
});

describe("AI authority and immutable batch validation", () => {
  it.each([{ aiAccess: "read" }, { aiAccess: "none" }, { internal: true }, { enabled: false }] as Partial<Variable>[])
    ("rejects write with gate %j", (gate) => {
      const { parse } = fixture([{ id: "locked", name: "locked", ...gate }]);
      expect(codes(parse(`[locked: add 1]\n${updated(1)}`))).toContain("not_writable");
    });
  it.each([
    ['[unknown: set 1]', "unknown_variable"], ['[bag.__proto__.polluted: set true]', "unsafe_path"],
    ['[bag.constructor.prototype: set true]', "unsafe_path"], ['[bag: merge {"__proto__":{"polluted":true}}]', "invalid_operation"],
    ['[health: set "fifty"]', "incompatible_value"], ['[health: add 1e309]', "invalid_operation"],
    ['[location: add 1]', "incompatible_value"], ['[health: toggle]', "incompatible_value"],
    ['[bag: push 1]', "incompatible_value"], ['[list: merge {"a":1}]', "incompatible_value"],
    ['[health.value: set 1]', "invalid_container"], ['[bag.count.value: set 1]', "invalid_container"],
  ])("rejects %s", (raw, code) => {
    const result = fixture().parse(`${raw}\n${updated(1)}`);
    expect(result.outcome).toBe("invalid");
    expect(codes(result)).toContain(code);
    expect(result.effects).toEqual([]);
  });
  it("does not mutate nested baseline, world defaults or caller operands", () => {
    const { world, state } = fixture();
    const effects: Effect[] = [{ variableId: "bag.items", operation: "push", value: { name: "rope" } }, { variableId: "bag.items.0.name", operation: "set", value: "changed" }];
    const before = structuredClone({ world, state, effects });
    expect(validateAiBatch(world, state, effects).diagnostics).toEqual([]);
    expect({ world, state, effects }).toEqual(before);
  });
  it("validates access against the original baseline even after a gate-changing command", () => {
    const { world, state } = fixture([{ id: "gated", name: "gated", activation: { mode: "conditions", conditions: [{ variableId: "key", operator: "eq", value: true }], conditionLogic: "all" } }]);
    const result = validateAiBatch(world, state, [{ variableId: "key", operation: "set", value: true }, { variableId: "gated", operation: "add", value: 1 }]);
    expect(result.effects).toEqual([]);
    expect(result.diagnostics).toContainEqual({ code: "not_writable" });
  });
  it("rejects non-finite operands and variable references before engine execution", () => {
    const { world, state } = fixture();
    for (const effect of [{ variableId: "health", operation: "add", value: Infinity }, { variableId: "health", operation: "add", value: 1, valueRef: "energy" }]) {
      expect(validateAiBatch(world, state, [effect as Effect]).effects).toEqual([]);
    }
  });
  it.each(["bag.items.-1", "bag.items.length", "bag.items.1oops", "bag.items.4294967295"])
    ("rejects invalid array access %s", (variableId) => {
      const { world, state } = fixture();
      const result = validateAiBatch(world, state, [{ variableId, operation: "delete", value: true }]);
      expect(result.effects).toEqual([]);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });
  it("allows setting at the array append boundary", () => {
    const { world, state } = fixture();
    const result = validateAiBatch(world, state, [{ variableId: "list.0", operation: "set", value: "rope" }]);
    expect(result.diagnostics).toEqual([]);
    const engine = new GameStateManager(world, state);
    engine.applyEffects(result.effects);
    expect(engine.get("list")).toEqual(["rope"]);
  });
  it.each([1, 10_000, 4_294_967_294])("rejects sparse-array growth at index %i", (index) => {
    const { world, state } = fixture();
    const before = structuredClone(state);
    const result = validateAiBatch(world, state, [{ variableId: `list.${index}`, operation: "set", value: "rope" }]);
    expect(result.effects).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(state).toEqual(before);
  });
});
