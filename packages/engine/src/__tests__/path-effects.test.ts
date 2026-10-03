import { describe, it, expect, beforeEach } from "vitest";
import { GameStateManager } from "../state/game-state-manager.js";
import { ResponseParser } from "../parser/response-parser.js";
import { createMockVariable, createMockWorld, resetIdCounter } from "./test-utils.js";

function mgrWith(defaults: Record<string, unknown>) {
  const variables = Object.entries(defaults).map(([id, defaultValue]) =>
    createMockVariable({ id, name: id, type: "json", defaultValue: defaultValue as never }),
  );
  return new GameStateManager(createMockWorld({ variables }));
}
const vars = (m: GameStateManager) => m.getSnapshot().variables as Record<string, any>;

describe("dot-path effects on a json variable", () => {
  beforeEach(() => resetIdCounter());

  describe("the op that names a new key creates it", () => {
    it("merge into a missing key creates the object", () => {
      const m = mgrWith({ rel: { chars: {} } });
      const changes = m.applyEffects([
        { variableId: "rel.chars.luyan", operation: "merge", value: { name: "陆衍", affection: 40 } },
      ]);
      expect(vars(m).rel).toEqual({ chars: { luyan: { name: "陆衍", affection: 40 } } });
      expect(changes).toHaveLength(1);
      expect(changes[0]!.variableId).toBe("rel");
    });

    it("merge into a missing key with a non-object value stays a no-op", () => {
      const m = mgrWith({ rel: { chars: {} } });
      m.applyEffects([{ variableId: "rel.chars.luyan", operation: "merge", value: "hi" }]);
      m.applyEffects([{ variableId: "rel.chars.lin", operation: "merge", value: [1, 2] }]);
      expect(vars(m).rel).toEqual({ chars: {} });
    });

    it("merge creates missing intermediate objects", () => {
      const m = mgrWith({ phone: {} });
      m.applyEffects([{ variableId: "phone.threads.luyan", operation: "merge", value: { unread: 0 } }]);
      expect(vars(m).phone).toEqual({ threads: { luyan: { unread: 0 } } });
    });

    it("push into a missing key starts a list", () => {
      const m = mgrWith({ phone: { threads: { luyan: {} } } });
      m.applyEffects([{ variableId: "phone.threads.luyan.messages", operation: "push", value: { text: "hi" } }]);
      expect(vars(m).phone.threads.luyan.messages).toEqual([{ text: "hi" }]);
    });

    it("add / subtract on a missing key count from 0", () => {
      const m = mgrWith({ phone: { threads: {} } });
      m.applyEffects([
        { variableId: "phone.threads.luyan.unread", operation: "add", value: 1 },
        { variableId: "phone.threads.lin.debt", operation: "subtract", value: 5 },
      ]);
      expect(vars(m).phone.threads.luyan.unread).toBe(1);
      expect(vars(m).phone.threads.lin.debt).toBe(-5);
    });

    it("a null leaf counts as missing", () => {
      const m = mgrWith({ s: { a: null, b: null, c: null } });
      m.applyEffects([
        { variableId: "s.a", operation: "merge", value: { x: 1 } },
        { variableId: "s.b", operation: "push", value: 1 },
        { variableId: "s.c", operation: "add", value: 2 },
      ]);
      expect(vars(m).s).toEqual({ a: { x: 1 }, b: [1], c: 2 });
    });

    it("merge copies the value rather than aliasing it", () => {
      const m = mgrWith({ rel: {} });
      const value = { name: "A", tags: ["x"] };
      m.applyEffects([{ variableId: "rel.a", operation: "merge", value }]);
      value.tags.push("y");
      expect(vars(m).rel.a.tags).toEqual(["x"]);
    });
  });

  describe("existing targets behave as before", () => {
    it("merge into an existing object shallow-merges", () => {
      const m = mgrWith({ rel: { chars: { luyan: { name: "陆衍", affection: 40 } } } });
      m.applyEffects([{ variableId: "rel.chars.luyan", operation: "merge", value: { affection: 45 } }]);
      expect(vars(m).rel.chars.luyan).toEqual({ name: "陆衍", affection: 45 });
    });

    it("push onto an existing list appends", () => {
      const m = mgrWith({ p: { list: [1] } });
      m.applyEffects([{ variableId: "p.list", operation: "push", value: 2 }]);
      expect(vars(m).p.list).toEqual([1, 2]);
    });

    it("add on an existing number adds", () => {
      const m = mgrWith({ p: { n: 3 } });
      m.applyEffects([{ variableId: "p.n", operation: "add", value: 2 }]);
      expect(vars(m).p.n).toBe(5);
    });

    it("wrong-shaped existing leaves are left alone", () => {
      const m = mgrWith({ p: { s: "text", n: 3, o: { a: 1 } } });
      m.applyEffects([
        { variableId: "p.s", operation: "push", value: 1 },
        { variableId: "p.s", operation: "add", value: 1 },
        { variableId: "p.n", operation: "merge", value: { a: 1 } },
        { variableId: "p.o", operation: "push", value: 1 },
      ]);
      expect(vars(m).p).toEqual({ s: "text", n: 3, o: { a: 1 } });
    });
  });

  describe("safety", () => {
    it("a path through a scalar is refused, not overwritten with a structure", () => {
      const m = mgrWith({ p: { hp: 30 } });
      const changes = m.applyEffects([
        { variableId: "p.hp.max", operation: "merge", value: { a: 1 } },
        { variableId: "p.hp.max", operation: "set", value: 1 },
        { variableId: "p.hp.max", operation: "push", value: 1 },
      ]);
      expect(vars(m).p).toEqual({ hp: 30 });
      expect(changes).toEqual([]);
    });

    it("refuses prototype keys", () => {
      const m = mgrWith({ p: {} });
      m.applyEffects([
        { variableId: "p.__proto__.polluted", operation: "set", value: true },
        { variableId: "p.constructor.prototype.polluted", operation: "set", value: true },
      ]);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(vars(m).p).toEqual({});
    });

    it("a path under a non-json variable is ignored", () => {
      const m = new GameStateManager(
        createMockWorld({ variables: [createMockVariable({ id: "hp", name: "hp", type: "number", defaultValue: 1 })] }),
      );
      expect(m.applyEffects([{ variableId: "hp.x", operation: "merge", value: { a: 1 } }])).toEqual([]);
    });
  });

  describe("array index paths", () => {
    it("dot-index reaches into an array element", () => {
      const m = mgrWith({ inv: { weapons: [{ name: "sword", durability: 10 }] } });
      m.applyEffects([
        { variableId: "inv.weapons.0.durability", operation: "subtract", value: 3 },
        { variableId: "inv.weapons.0.tags", operation: "push", value: "sharp" },
      ]);
      expect(vars(m).inv.weapons[0]).toEqual({ name: "sword", durability: 7, tags: ["sharp"] });
      expect(Array.isArray(vars(m).inv.weapons)).toBe(true);
    });

    it("bracket-index spelling is the same path", () => {
      const m = mgrWith({ inv: { weapons: [{ durability: 10 }] }, list: [{ hp: 1 }] });
      m.applyEffects([
        { variableId: "inv.weapons[0].durability", operation: "add", value: 5 },
        { variableId: "list[0].hp", operation: "add", value: 1 },
      ]);
      expect(vars(m).inv.weapons[0].durability).toBe(15);
      expect(vars(m).list[0].hp).toBe(2);
    });

    it("delete by index still splices", () => {
      const m = mgrWith({ inv: { weapons: ["a", "b", "c"] } });
      m.applyEffects([{ variableId: "inv.weapons.1", operation: "delete", value: 0 }]);
      expect(vars(m).inv.weapons).toEqual(["a", "c"]);
    });
  });

  it("an App-pack turn about a new character fills both apps (parser → effects)", () => {
    const m = mgrWith({ app_relations: { chars: {} }, app_phone: { threads: {}, moments: [] } });
    const text = `hello
[app_relations.chars.luyan: merge {"name": "陆衍", "affection": 40}]
[app_phone.threads.luyan: merge {"name": "陆衍", "unread": 0, "messages": []}]
[app_phone.threads.luyan.messages: push {"from": "them", "text": "周末有空吗？"}]
[app_phone.threads.luyan.unread: +1]`;
    const world = createMockWorld({
      variables: [
        createMockVariable({ id: "app_relations", name: "r", type: "json", defaultValue: { chars: {} } as never }),
        createMockVariable({ id: "app_phone", name: "p", type: "json", defaultValue: { threads: {}, moments: [] } as never }),
      ],
    });
    const parsed = new ResponseParser().parse(text, world.variables);
    m.applyEffects(parsed.effects);
    expect(vars(m).app_relations.chars.luyan).toEqual({ name: "陆衍", affection: 40 });
    expect(vars(m).app_phone.threads.luyan).toEqual({
      name: "陆衍",
      unread: 1,
      messages: [{ from: "them", text: "周末有空吗？" }],
    });
  });
});
