import { describe, it, expect } from "vitest";
import { activeNarrator, followingVoices, replyRoom } from "../station.js";
import { computeActiveWorldbookIds, filterEntriesByActiveWorldbooks } from "../worldbook.js";
import { diagnoseStation } from "../station-diagnostics.js";
import type { GameState, Worldbook, WorldEntry } from "../../types/index.js";

const book = (over: Partial<Worldbook> & { id: string }): Worldbook => ({
  name: over.id,
  activation: { mode: "always" },
  order: 0,
  ...over,
});
const state = (over: Partial<GameState> = {}): GameState => ({ variables: {}, turnCount: 0, ...over } as GameState);
const entry = (id: string, worldbookId?: string): WorldEntry => ({ id, name: id, content: id, worldbookId } as WorldEntry);

// A dungeon that opens when the player walks in, a guide and a rival living in
// it, a cat living on the card, and an AI added from the menu and put nowhere.
const dungeon = book({ id: "dungeon", order: 1, activation: { mode: "keywords", keywords: ["进去"] } });
const guide = book({ id: "guide", order: 1, host: "dungeon", station: { kind: "narrator" } });
const rival = book({ id: "rival", order: 2, host: "dungeon", station: { kind: "narrator" } });
const cat = book({ id: "cat", order: 0, host: "card", station: { kind: "narrator" } });
const loose = book({ id: "loose", order: 0, host: "unplaced", station: { kind: "narrator" } });
const books = [dungeon, guide, rival, cat, loose];
const inDungeon = state({ ruleState: { toggledWorldbooks: { dungeon: true } } } as unknown as Partial<GameState>);

describe("an AI lives somewhere and is in play when that place is", () => {
  it("on the card: always; in a situation: while it is on; put nowhere: never", () => {
    const outside = computeActiveWorldbookIds(books, state());
    expect(outside.has("cat")).toBe(true);
    expect(outside.has("guide")).toBe(false);
    expect(outside.has("loose")).toBe(false);
    const inside = computeActiveWorldbookIds(books, inDungeon);
    expect([...inside].sort()).toEqual(["cat", "dungeon", "guide", "rival"]);
  });

  it("its own activation is not read", () => {
    const keyed = book({ id: "keyed", host: "card", station: { kind: "narrator" }, activation: { mode: "keywords", keywords: [] } });
    expect(computeActiveWorldbookIds([keyed], state()).has("keyed")).toBe(true);
  });

  it("switched off stays off wherever it lives", () => {
    expect(computeActiveWorldbookIds([{ ...cat, enabled: false }], state()).has("cat")).toBe(false);
  });

  it("an AI put inside another AI is nowhere", () => {
    const nested = book({ id: "nested", host: "cat", station: { kind: "narrator" } });
    expect(computeActiveWorldbookIds([cat, nested], state()).has("nested")).toBe(false);
  });
});

describe("replyRoom — who answers the player", () => {
  it("on the card: the narrator first, then the AIs that live on the card", () => {
    const active = computeActiveWorldbookIds(books, state());
    const room = replyRoom(books, active);
    expect(room.id).toBe("card");
    expect(room.members.map((m) => m?.id ?? "narrator")).toEqual(["narrator", "cat"]);
    expect(activeNarrator(books, active)).toBeNull();
    expect(followingVoices(books, active).map((b) => b.id)).toEqual(["cat"]);
  });

  it("inside a situation with AIs: they answer instead of the narrator, in order", () => {
    const active = computeActiveWorldbookIds(books, inDungeon);
    const room = replyRoom(books, active);
    expect(room.id).toBe("dungeon");
    expect(room.members.map((m) => m?.id ?? "narrator")).toEqual(["guide", "rival"]);
    expect(activeNarrator(books, active)!.id).toBe("guide");
  });

  it("a situation that keeps the narrator puts it first", () => {
    const kept = books.map((b) => (b.id === "dungeon" ? { ...b, narratorHere: true } : b));
    const room = replyRoom(kept, computeActiveWorldbookIds(kept, inDungeon));
    expect(room.members.map((m) => m?.id ?? "narrator")).toEqual(["narrator", "guide", "rival"]);
  });

  it("a situation with no AI is no room: the card keeps talking", () => {
    const plain = [book({ id: "town" }), cat];
    expect(replyRoom(plain, computeActiveWorldbookIds(plain, state())).id).toBe("card");
  });

  it("the older shape still reads the same: a situation that is its own AI takes over alone", () => {
    const d1 = book({ id: "d1", order: 1, station: { kind: "narrator" } });
    const d2 = book({ id: "d2", order: 2, station: { kind: "narrator" } });
    const room = replyRoom([d2, d1], new Set(["d1", "d2"]));
    expect(room.id).toBe("d1");
    expect(room.members.map((m) => m?.id)).toEqual(["d1"]);
  });
});

describe("what only one AI knows reaches only that one", () => {
  const entries = [entry("world"), entry("dungeon-lore", "dungeon"), entry("guide-self", "guide"), entry("rival-self", "rival"), entry("cat-self", "cat")];

  it("the first voice's prompt carries its own entries and none of the others'", () => {
    const kept = filterEntriesByActiveWorldbooks(entries, books, inDungeon).map((e) => e.id);
    expect(kept).toEqual(["world", "dungeon-lore", "guide-self"]);
  });

  it("on the card the narrator answers first and reads no AI's own entries", () => {
    const kept = filterEntriesByActiveWorldbooks(entries, books, state()).map((e) => e.id);
    expect(kept).toEqual(["world"]);
  });
});

describe("diagnostics", () => {
  it("an AI put nowhere says so; two AIs in one place are not shadowing each other", () => {
    expect(diagnoseStation(loose, books).map((d) => d.code)).toContain("ai.unplaced");
    expect(diagnoseStation(rival, books).map((d) => d.code)).not.toContain("narrator.shadowed");
  });

  it("an AI whose place is gone is an error", () => {
    const orphan = book({ id: "orphan", host: "gone", station: { kind: "narrator" } });
    expect(diagnoseStation(orphan, [orphan]).map((d) => d.code)).toContain("ai.placeMissing");
  });
});
