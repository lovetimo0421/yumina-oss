import { describe, it, expect } from "vitest";
import { revertTurn } from "../world/revert-turn.js";
import type { WorldDefinition } from "../types/index.js";

function world(partial: Record<string, unknown>): WorldDefinition {
  return { name: "Card", entries: [], variables: [], settings: {}, ...partial } as unknown as WorldDefinition;
}
const e = (id: string, content = id, extra: Record<string, unknown> = {}) => ({ id, name: id, content, section: "lore", ...extra });
const ids = (arr: unknown) => (arr as Array<{ id: string }>).map((x) => x.id);

describe("revertTurn — an item the turn created", () => {
  it("is removed when the author has not touched it", () => {
    const before = world({ entries: [e("a")] });
    const end = world({ entries: [e("a"), e("new")] });
    const { world: out, kept } = revertTurn(before, end, end);
    expect(ids(out.entries)).toEqual(["a"]);
    expect(kept).toEqual([]);
  });

  it("stays, and is reported, when the author has edited it since", () => {
    const before = world({ entries: [e("a")] });
    const end = world({ entries: [e("a"), e("new", "assistant")] });
    const now = world({ entries: [e("a"), e("new", "author rewrote it")] });
    const { world: out, kept } = revertTurn(before, end, now);
    expect(out.entries.find((x) => x.id === "new")?.content).toBe("author rewrote it");
    expect(kept).toEqual(["entries/new"]);
  });

  it("stays gone, quietly, when the author already deleted it", () => {
    const before = world({ entries: [e("a")] });
    const end = world({ entries: [e("a"), e("new")] });
    const now = world({ entries: [e("a")] });
    const r = revertTurn(before, end, now);
    expect(ids(r.world.entries)).toEqual(["a"]);
    expect(r.kept).toEqual([]);
  });
});

describe("revertTurn — an item the turn deleted", () => {
  it("comes back where it stood", () => {
    const before = world({ variables: [e("hp"), e("mp"), e("gold")] });
    const end = world({ variables: [e("hp"), e("gold")] });
    const { world: out, kept } = revertTurn(before, end, end);
    expect(ids(out.variables)).toEqual(["hp", "mp", "gold"]);
    expect(kept).toEqual([]);
  });

  it("does not replace something the author has since made under the same id", () => {
    const before = world({ variables: [e("hp", "old")] });
    const end = world({ variables: [] });
    const now = world({ variables: [e("hp", "author's own")] });
    const { world: out, kept } = revertTurn(before, end, now);
    expect(out.variables).toEqual([e("hp", "author's own")]);
    expect(kept).toEqual(["variables/hp"]);
  });

  it("comes back near its old neighbours even after the author's own edits around it", () => {
    const before = world({ entries: [e("a"), e("b"), e("c"), e("d")] });
    const end = world({ entries: [e("a"), e("d")] });
    // The author adds one at the top afterwards.
    const now = world({ entries: [e("top"), e("a"), e("d")] });
    const { world: out } = revertTurn(before, end, now);
    expect(ids(out.entries)).toEqual(["top", "a", "b", "c", "d"]);
  });
});

describe("revertTurn — an item the turn changed", () => {
  it("goes back to its old self when the author has not touched it", () => {
    const before = world({ entries: [e("a", "old"), e("b")] });
    const end = world({ entries: [e("a", "assistant"), e("b")] });
    const now = world({ entries: [e("a", "assistant"), e("b", "author edit")] });
    const { world: out, kept } = revertTurn(before, end, now);
    expect(out.entries).toEqual([e("a", "old"), e("b", "author edit")]);
    expect(kept).toEqual([]);
  });

  it("keeps the author's version, and reports it, when both changed it", () => {
    const before = world({ entries: [e("a", "old")] });
    const end = world({ entries: [e("a", "assistant")] });
    const now = world({ entries: [e("a", "author")] });
    const { world: out, kept } = revertTurn(before, end, now);
    expect(out.entries).toEqual([e("a", "author")]);
    expect(kept).toEqual(["entries/a"]);
  });

  it("keeps it deleted when the author deleted the assistant's version", () => {
    const before = world({ reactions: [e("r1", "old")] });
    const end = world({ reactions: [e("r1", "assistant")] });
    const now = world({ reactions: [] });
    const { world: out, kept } = revertTurn(before, end, now);
    expect(out.reactions).toEqual([]);
    expect(kept).toEqual(["reactions/r1"]);
  });

  it("is no clash when the author already changed it back", () => {
    const before = world({ entries: [e("a", "old")] });
    const end = world({ entries: [e("a", "assistant")] });
    const now = world({ entries: [e("a", "old")] });
    const r = revertTurn(before, end, now);
    expect(r.world).toBe(now);
    expect(r.kept).toEqual([]);
  });

  it("does not count an entry only shifted by a sibling's arrival as the turn's edit", () => {
    const before = world({ entries: [e("a", "a", { position: 0 }), e("b", "b", { position: 1 })] });
    const end = world({ entries: [e("new", "n", { position: 0 }), e("a", "a", { position: 1 }), e("b", "b", { position: 2 })] });
    // The author then edits b: that is not a clash with the turn.
    const now = world({ entries: [e("new", "n", { position: 0 }), e("a", "a", { position: 1 }), e("b", "author", { position: 2 })] });
    const { world: out, kept } = revertTurn(before, end, now);
    expect(ids(out.entries)).toEqual(["a", "b"]);
    expect(out.entries.find((x) => x.id === "b")?.content).toBe("author");
    expect(kept).toEqual([]);
  });
});

describe("revertTurn — what the turn did not touch", () => {
  it("never changes, whatever the author did to it", () => {
    const before = world({ name: "Card", entries: [e("a")], worldbooks: [e("wb1")] });
    const end = world({ name: "Card", entries: [e("a"), e("new")], worldbooks: [e("wb1")] });
    const now = world({ name: "Renamed", entries: [e("a"), e("new"), e("mine")], worldbooks: [] });
    const { world: out, kept } = revertTurn(before, end, now);
    expect(out.name).toBe("Renamed");
    expect(ids(out.entries)).toEqual(["a", "mine"]);
    expect(out.worldbooks).toEqual([]);
    expect(kept).toEqual([]);
  });

  it("returns the card itself when the turn changed nothing", () => {
    const before = world({ entries: [e("a")] });
    const now = world({ entries: [e("a", "author")] });
    expect(revertTurn(before, before, now).world).toBe(now);
  });

  it("leaves the board layout and the cover as they are", () => {
    const before = world({ graphLayout: { nodes: {} }, avatar: "old.png" });
    const end = world({ graphLayout: { nodes: { x: 1 } }, avatar: "new.png" });
    const { world: out } = revertTurn(before, end, end);
    expect(out).toBe(end);
  });
});

describe("revertTurn — settings and other fields", () => {
  it("goes key by key through settings", () => {
    const before = world({ settings: { temperature: 1, playerName: "User", maxTokens: 100 } });
    const end = world({ settings: { temperature: 0.7, playerName: "Hero", maxTokens: 100, topK: 40 } });
    const now = world({ settings: { temperature: 0.7, playerName: "Alex", maxTokens: 200, topK: 40 } });
    const { world: out, kept } = revertTurn(before, end, now);
    // temperature: assistant only → back. playerName: both → author's. maxTokens:
    // author only → theirs. topK: added by the assistant, untouched → removed.
    expect(out.settings).toEqual({ temperature: 1, playerName: "Alex", maxTokens: 200 });
    expect(kept).toEqual(["settings.playerName"]);
  });

  it("puts back a whole field the turn changed when the author left it alone", () => {
    const before = world({ description: "old", uiDoc: { version: 1, pages: [e("p1")], entryPageId: "p1" } });
    const end = world({ description: "new", uiDoc: { version: 1, pages: [e("p1"), e("p2")], entryPageId: "p2" } });
    const { world: out } = revertTurn(before, end, end);
    expect(out.description).toBe("old");
    expect(out.uiDoc).toEqual(before.uiDoc);
  });

  it("merges interface files one by one and drops a compile of a mix it never built", () => {
    const rc = (files: Record<string, string>, compiled: string) => ({ id: "root", entryFile: "index.tsx", files, compiled: { code: compiled } });
    const before = world({ rootComponent: rc({ "index.tsx": "v1", "style.css": "s1" }, "c1") });
    const end = world({ rootComponent: rc({ "index.tsx": "assistant", "style.css": "s1", "extra.tsx": "x" }, "c2") });
    const now = world({ rootComponent: rc({ "index.tsx": "assistant", "style.css": "author" , "extra.tsx": "x" }, "c3") });
    const { world: out, kept } = revertTurn(before, end, now);
    expect(out.rootComponent?.files).toEqual({ "index.tsx": "v1", "style.css": "author" });
    expect(out.rootComponent?.compiled).toBeUndefined();
    expect(kept).toEqual([]);
  });
});

describe("revertTurn — order", () => {
  it("undoes the turn's reshuffle when the author has not rearranged since", () => {
    const before = world({ entries: [e("a"), e("b"), e("c")] });
    const end = world({ entries: [e("c"), e("a"), e("b", "assistant")] });
    const now = world({ entries: [e("c"), e("a", "author"), e("b", "assistant")] });
    const { world: out } = revertTurn(before, end, now);
    expect(ids(out.entries)).toEqual(["a", "b", "c"]);
    expect(out.entries.map((x) => x.content)).toEqual(["author", "b", "c"]);
  });

  it("keeps the author's own rearranging, and fits restored items into it", () => {
    const before = world({ entries: [e("a"), e("b"), e("c"), e("d")] });
    const end = world({ entries: [e("a"), e("c"), e("d")] });
    const now = world({ entries: [e("d"), e("c"), e("a")] });
    const { world: out } = revertTurn(before, end, now);
    // b stood right after a.
    expect(ids(out.entries)).toEqual(["d", "c", "a", "b"]);
  });

  it("keeps an author's new item where they put it while the old order comes back", () => {
    const before = world({ entries: [e("a"), e("b"), e("c")] });
    const end = world({ entries: [e("a"), e("b", "assistant"), e("c")] });
    const now = world({ entries: [e("a"), e("mine"), e("b", "assistant"), e("c")] });
    const { world: out } = revertTurn(before, end, now);
    expect(ids(out.entries)).toEqual(["a", "mine", "b", "c"]);
    expect(out.entries[2]?.content).toBe("b");
  });
});
