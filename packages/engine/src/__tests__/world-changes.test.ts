import { describe, it, expect } from "vitest";
import { applyWorldChanges, diffWorld, isWorldChangeList, rebaseWorld } from "../world/changes.js";
import { mergeWorldDefinition } from "../world/merge.js";
import type { WorldDefinition } from "../types/index.js";

function world(partial: Record<string, unknown>): WorldDefinition {
  return { entries: [], variables: [], rules: [], ...partial } as unknown as WorldDefinition;
}
const e = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ id, name: id, content, ...extra });
const ids = (w: WorldDefinition) => (w.entries as unknown as { id: string }[]).map((x) => x.id);
const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("diffWorld / applyWorldChanges", () => {
  it("round-trips arbitrary edits through JSON", () => {
    const base = world({
      name: "A", entries: [e("a", "1"), e("b", "2"), e("c", "3")], uiDoc: { v: 1 },
      rootComponent: { entryFile: "index.tsx", files: { "index.tsx": "x", "old.tsx": "o" } },
      systems: ["s"],
    });
    const next = world({
      name: "B", entries: [e("c", "3"), e("a", "1!", { tag: 1 }), e("d", "4")], uiDoc: { v: 2 },
      rootComponent: { entryFile: "index.tsx", files: { "index.tsx": "y", "new.tsx": "n" }, compiled: { code: "c" } },
    });
    const changes = roundTrip(diffWorld(base, next));
    expect(isWorldChangeList(changes)).toBe(true);
    // The compiled bundle travels beside the change set, never in it.
    const { compiled: _compiled, ...root } = next.rootComponent as unknown as Record<string, unknown>;
    expect(applyWorldChanges(base, changes)).toEqual({ ...next, rootComponent: root });
  });

  it("sends only the fields of a row that changed", () => {
    const base = world({ entries: [e("a", "old", { name: "Alice" })] });
    const next = world({ entries: [e("a", "new", { name: "Alice" })] });
    expect(diffWorld(base, next)).toEqual([{ op: "rowFields", key: "entries", id: "a", set: { content: "new" } }]);
  });

  it("lets two people edit different fields of one entry", () => {
    const base = world({ entries: [e("a", "old", { name: "Alice" })] });
    const mine = diffWorld(base, world({ entries: [e("a", "old", { name: "Alicia" })] }));
    const theirs = diffWorld(base, world({ entries: [e("a", "new text", { name: "Alice" })] }));
    const server = applyWorldChanges(applyWorldChanges(base, theirs), mine);
    expect(server.entries[0]).toMatchObject({ name: "Alicia", content: "new text" });
  });

  it("is last-write-wins on the same field, and a delete beats a later field edit", () => {
    const base = world({ entries: [e("a", "old")] });
    const first = diffWorld(base, world({ entries: [e("a", "first")] }));
    const second = diffWorld(base, world({ entries: [e("a", "second")] }));
    expect(applyWorldChanges(applyWorldChanges(base, first), second).entries[0]).toMatchObject({ content: "second" });
    const deleted = applyWorldChanges(base, diffWorld(base, world({ entries: [] })));
    expect(applyWorldChanges(deleted, second).entries).toEqual([]);
  });

  it("keeps another person's new row in place when applying an order", () => {
    const base = world({ entries: [e("a", ""), e("b", ""), e("c", "")] });
    const reordered = diffWorld(base, world({ entries: [e("c", ""), e("b", ""), e("a", "")] }));
    const withTheirs = applyWorldChanges(base, [{ op: "row", key: "entries", id: "x", row: e("x", ""), after: "a" }]);
    expect(ids(applyWorldChanges(withTheirs, reordered))).toEqual(["c", "b", "a", "x"]);
  });

  it("keeps two people's drags of different rows", () => {
    const base = world({ entries: [e("a", ""), e("b", ""), e("c", ""), e("d", ""), e("f", "")] });
    const mine = diffWorld(base, world({ entries: [e("b", ""), e("c", ""), e("a", ""), e("d", ""), e("f", "")] }));
    expect(mine).toEqual([{ op: "move", key: "entries", id: "a", after: "c" }]);
    const theirs = applyWorldChanges(base, diffWorld(base, world({ entries: [e("a", ""), e("b", ""), e("c", ""), e("f", ""), e("d", "")] })));
    expect(ids(applyWorldChanges(theirs, mine))).toEqual(["b", "c", "a", "f", "d"]);
  });

  it("places new rows after their neighbour", () => {
    const base = world({ entries: [e("a", ""), e("b", "")] });
    const next = world({ entries: [e("n", ""), e("a", ""), e("m", ""), e("b", "")] });
    expect(ids(applyWorldChanges(base, diffWorld(base, next)))).toEqual(["n", "a", "m", "b"]);
  });

  it("falls back to whole-field writes when rows lack ids", () => {
    const base = world({ replyRules: [{ name: "x" }] });
    const next = world({ replyRules: [{ name: "y" }] });
    expect(diffWorld(base, next)).toEqual([{ op: "field", key: "replyRules", value: [{ name: "y" }] }]);
  });

  it("rebases unsent local edits onto a newer server copy", () => {
    const base = world({ name: "A", entries: [e("a", "1"), e("b", "2")] });
    const local = world({ name: "A", entries: [e("a", "mine"), e("b", "2")] });
    const server = world({ name: "Theirs", entries: [e("a", "1"), e("b", "theirs"), e("c", "new")] });
    const rebased = rebaseWorld(base, local, server);
    expect(rebased.name).toBe("Theirs");
    expect((rebased.entries as unknown as { content: string }[]).map((x) => x.content)).toEqual(["mine", "theirs", "new"]);
  });

  it("sends only the canvas node or sticky note that moved", () => {
    const note = (id: string, text: string) => ({ id, x: 0, y: 0, w: 100, h: 80, text });
    const base = world({ graphLayout: { version: 1, nodes: { a: { x: 0, y: 0 } }, notes: [note("n1", "a")] } });
    const next = world({ graphLayout: { version: 1, nodes: { a: { x: 5, y: 0 } }, notes: [note("n1", "a"), note("n2", "b")] } });
    expect(diffWorld(base, next)).toEqual([
      { op: "set", path: ["graphLayout", "nodes", "a", "x"], value: 5 },
      { op: "addRow", path: ["graphLayout", "notes"], row: note("n2", "b"), after: "n1" },
    ]);
    // Someone else's note landed meanwhile: ours goes in beside it, theirs stays.
    const theirs = applyWorldChanges(base, [{ op: "addRow", path: ["graphLayout", "notes"], row: note("x", "theirs"), after: "n1" }]);
    const out = applyWorldChanges(theirs, diffWorld(base, next));
    expect(out.graphLayout?.notes?.map((n) => n.id)).toEqual(["n1", "n2", "x"]);
    expect(out.graphLayout?.nodes.a).toEqual({ x: 5, y: 0 });
  });

  it("edits one interface page without touching another person's page", () => {
    const page = (id: string, title: string) => ({ id, title });
    const doc = (pages: unknown[]) => ({ version: 1, entryPageId: "p1", pages }) as unknown as WorldDefinition["uiDoc"];
    const base = world({ uiDoc: doc([page("p1", "one"), page("p2", "two")]) });
    const mine = diffWorld(base, world({ uiDoc: doc([page("p1", "ONE"), page("p2", "two")]) }));
    const theirs = applyWorldChanges(base, diffWorld(base, world({ uiDoc: doc([page("p1", "one"), page("p2", "TWO")]) })));
    expect((applyWorldChanges(theirs, mine).uiDoc as unknown as { pages: unknown[] }).pages).toEqual([page("p1", "ONE"), page("p2", "TWO")]);
  });

  it("drops a nested edit whose row someone removed", () => {
    const base = world({ graphLayout: { version: 1, nodes: {}, notes: [{ id: "n1", x: 0, y: 0, w: 1, h: 1, text: "a" }] } });
    const edit = diffWorld(base, world({ graphLayout: { version: 1, nodes: {}, notes: [{ id: "n1", x: 0, y: 0, w: 1, h: 1, text: "b" }] } }));
    const removed = applyWorldChanges(base, [{ op: "removeRow", path: ["graphLayout", "notes"], id: "n1" }]);
    expect(applyWorldChanges(removed, edit).graphLayout?.notes).toEqual([]);
  });

  it("sends an object whole when one of its keys can't be named in a path", () => {
    const base = world({ settings: { "": "none", a: 1 } } as unknown as Partial<WorldDefinition>);
    const next = world({ settings: { "": "none", a: 2 } } as unknown as Partial<WorldDefinition>);
    const changes = diffWorld(base, next);
    expect(changes).toEqual([{ op: "set", path: ["settings"], value: { "": "none", a: 2 } }]);
    expect(isWorldChangeList(changes)).toBe(true);
  });

  it("keeps both people's first sticky notes on a card that had no layout yet", () => {
    const note = (id: string) => ({ id, x: 0, y: 0, w: 1, h: 1, text: id });
    const base = world({});
    const mine = diffWorld(base, world({ graphLayout: { version: 1, nodes: {}, notes: [note("mine")] } }));
    const theirs = applyWorldChanges(base, diffWorld(base, world({ graphLayout: { version: 1, nodes: {}, notes: [note("theirs")] } })));
    expect(applyWorldChanges(theirs, mine).graphLayout?.notes?.map((n) => n.id)).toEqual(["mine", "theirs"]);
    expect(mergeWorldDefinition(base, world({ graphLayout: { version: 1, nodes: {}, notes: [note("mine")] } }), theirs).merged.graphLayout?.notes?.map((n) => n.id)).toEqual(["mine", "theirs"]);
  });

  it("rejects malformed nested paths", () => {
    expect(isWorldChangeList([{ op: "set", path: ["graphLayout", "__proto__"], value: 1 }])).toBe(false);
    expect(isWorldChangeList([{ op: "set", path: [{ id: "x" }], value: 1 }])).toBe(false);
    expect(isWorldChangeList([{ op: "set", path: [] }])).toBe(false);
    expect(isWorldChangeList([{ op: "removeRow", path: ["graphLayout", "notes"], id: "n" }])).toBe(true);
  });

  it("rejects malformed or prototype-polluting change sets", () => {
    expect(isWorldChangeList([{ op: "field", key: "__proto__", value: {} }])).toBe(false);
    expect(isWorldChangeList([{ op: "row", key: "entries", id: "a", row: { id: "b" } }])).toBe(false);
    expect(isWorldChangeList([{ op: "rowFields", key: "entries", id: "a", set: { id: "b" } }])).toBe(false);
    expect(isWorldChangeList([{ op: "nope" }])).toBe(false);
    expect(isWorldChangeList("x")).toBe(false);
  });
});
