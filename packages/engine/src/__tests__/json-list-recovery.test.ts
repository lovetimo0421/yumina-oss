import { describe, expect, it } from "vitest";
import { ResponseParser } from "../parser/response-parser.js";
import { GameStateManager } from "../state/game-state-manager.js";
import { createMockGameState, createMockVariable, createMockWorld } from "./test-utils.js";

const world = createMockWorld({ variables: [
  createMockVariable({ id: "phone_sms", type: "json", defaultValue: "[]" }),
  createMockVariable({ id: "contacts", type: "json", defaultValue: "{}" }),
  createMockVariable({ id: "log", type: "string", defaultValue: "Existing. " }),
] });
const first = { npcId: "coach", text: "Training, then lunch", read: false };
const second = { npcId: "coach", text: "Bring boots", read: false };
const parser = new ResponseParser();

describe("recovered list directives preserve their operation", () => {
  it.each([{ initial: [] }, { initial: "[]" }])("appends both comma-separated objects without replacing the list ($initial)", ({ initial }) => {
    const result = parser.parse(`Done.\n[phone_sms: push ${JSON.stringify(first)},${JSON.stringify(second)}]`, undefined, { world });
    expect(result.effects.map(({ operation }) => operation)).toEqual(["push", "push"]);
    expect(result.unapplied).toBeUndefined();
    const manager = new GameStateManager(world, createMockGameState({ variables: { phone_sms: initial } }));
    manager.applyEffects(result.effects);
    expect(manager.get("phone_sms")).toEqual([first, second]);
    expect(result.cleanText).toBe("Done.");
  });

  it("preserves previous messages and nested JSON in comma-separated pushes", () => {
    const previous = { npcId: "friend", text: "Earlier" };
    const item = { ...first, attachments: [{ name: "[boots], kit" }] };
    const result = parser.parse(`[phone_sms: push ${JSON.stringify(item)},${JSON.stringify(second)}]`, undefined, { world });
    const manager = new GameStateManager(world, createMockGameState({ variables: { phone_sms: [previous] } }));
    manager.applyEffects(result.effects);
    expect(manager.get("phone_sms")).toEqual([previous, item, second]);
  });

  it("retains append semantics for a bare continuation", () => {
    const result = parser.parse('[log: append "First", "Second"]', undefined, { world });
    const manager = new GameStateManager(world);
    manager.applyEffects(result.effects);
    expect(manager.get("log")).toBe("Existing. FirstSecond");
  });

  it("does not carry a push across a different target or an explicit operation", () => {
    const result = parser.parse('[phone_sms: push {"text":"First"}, log: "New", "Ambiguous", phone_sms: set []]', undefined, { world });
    expect(result.effects).toEqual([
      { variableId: "phone_sms", operation: "push", value: { text: "First" } },
      { variableId: "log", operation: "set", value: "New" },
      { variableId: "phone_sms", operation: "set", value: [] },
    ]);
    expect(result.unapplied).toHaveLength(1);
  });

  it("reports a bare object after set rather than silently overwriting the first value", () => {
    const result = parser.parse('[contacts: set {"coach":1},{"friend":2}]', undefined, { world });
    expect(result.effects).toEqual([{ variableId: "contacts", operation: "set", value: { coach: 1 } }]);
    expect(result.unapplied).toHaveLength(1);
  });
});

describe("legacy serialized JSON state", () => {
  it("normalizes array/object defaults so push and nested writes work on the first turn", () => {
    const manager = new GameStateManager(world);
    manager.applyEffects([
      { variableId: "phone_sms", operation: "push", value: first },
      { variableId: "contacts.coach", operation: "set", value: { name: "Coach" } },
    ]);
    expect(manager.get("phone_sms")).toEqual([first]);
    expect(manager.get("contacts")).toEqual({ coach: { name: "Coach" } });
    expect(world.variables[0]!.defaultValue).toBe("[]");
  });

  it("normalizes saved snapshots without mutating the caller's data", () => {
    const snapshot = createMockGameState({ variables: { phone_sms: JSON.stringify([first]), contacts: '{"coach":{"name":"Coach"}}' } });
    const manager = new GameStateManager(world, snapshot);
    manager.applyEffects([{ variableId: "phone_sms", operation: "push", value: second }]);
    expect(manager.get("phone_sms")).toEqual([first, second]);
    expect(snapshot.variables.phone_sms).toBe(JSON.stringify([first]));
    manager.loadSnapshot(snapshot);
    expect(manager.get("phone_sms")).toEqual([first]);
  });

  it("keeps JSON scalars, malformed text, and declared string variables unchanged", () => {
    const scalarWorld = createMockWorld({ variables: [
      ...["true", "12", '"text"', "null", "{broken"].map((defaultValue, i) => createMockVariable({ id: `json${i}`, type: "json", defaultValue })),
      createMockVariable({ id: "text", type: "string", defaultValue: "[]" }),
    ] });
    const manager = new GameStateManager(scalarWorld);
    expect(manager.getSnapshot().variables).toEqual(Object.fromEntries(scalarWorld.variables.map(v => [v.id, v.defaultValue])));
  });
});
