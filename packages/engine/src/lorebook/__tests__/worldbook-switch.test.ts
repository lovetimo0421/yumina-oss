import { describe, it, expect } from "vitest";
import { applyWorldbookSwitches, matchWorldbookSwitches } from "../worldbook-switch.js";
import { computeActiveWorldbookIds } from "../worldbook.js";
import type { GameState, Worldbook } from "../../types/index.js";

const dungeon = (id: string, keywords: string[], exclusive = true): Worldbook => ({
  id, name: id, order: 0,
  activation: { mode: "keywords", keywords, exclusive },
});

const state = (toggledWorldbooks: Record<string, boolean>): GameState =>
  ({
    worldId: "w", variables: {}, turnCount: 0, flags: {}, history: [],
    ruleState: { activeDirectives: [], cooldowns: {}, fireCounts: {}, prevVars: {}, toggledEntries: {}, toggledWorldbooks },
  }) as unknown as GameState;

const books = [dungeon("a", ["地下室", "basement"]), dungeon("b", ["阁楼"])];

describe("keyword-switched modules", () => {
  it("start dark — a door nobody has walked through is shut", () => {
    expect([...computeActiveWorldbookIds(books, state({}))]).toEqual([]);
  });

  it("latch on, and stay on after the word scrolls away", () => {
    const hit = matchWorldbookSwitches(books, "我推开门走进地下室");
    expect(hit).toEqual({ on: ["a"], off: [] });

    const latched = applyWorldbookSwitches({}, hit);
    expect([...computeActiveWorldbookIds(books, state(latched))]).toEqual(["a"]);

    // The whole point of latching: a later message that says nothing about
    // the basement must not close it.
    const quiet = matchWorldbookSwitches(books, "我看了看四周", latched);
    expect(quiet).toEqual({ on: [], off: [] });
    expect([...computeActiveWorldbookIds(books, state(applyWorldbookSwitches(latched, quiet)))]).toEqual(["a"]);
  });

  it("close the room you left when you walk into another one", () => {
    const inA = applyWorldbookSwitches({}, matchWorldbookSwitches(books, "地下室"));
    const moved = matchWorldbookSwitches(books, "我爬上阁楼", inA);
    expect(moved).toEqual({ on: ["b"], off: ["a"] });
    expect([...computeActiveWorldbookIds(books, state(applyWorldbookSwitches(inA, moved)))]).toEqual(["b"]);
  });

  it("re-saying the room you are in still closes the others", () => {
    const both = { a: true, b: true };
    // Already on, so nothing to latch — but b is an exclusive sibling that
    // did not match, and leaving it open would be a second dungeon running.
    expect(matchWorldbookSwitches(books, "回到地下室", both)).toEqual({ on: [], off: ["b"] });
  });

  it("leave non-exclusive modules alone — they accumulate on purpose", () => {
    const notes = [dungeon("a", ["地下室"]), dungeon("hint", ["线索"], false)];
    const first = applyWorldbookSwitches({}, matchWorldbookSwitches(notes, "线索"));
    const second = matchWorldbookSwitches(notes, "地下室", first);
    expect(second.off).toEqual([]);
    expect([...computeActiveWorldbookIds(notes, state(applyWorldbookSwitches(first, second)))].sort()).toEqual(["a", "hint"]);
  });

  it("ignores a disabled module and an empty keyword list", () => {
    const odd: Worldbook[] = [
      { ...dungeon("off", ["地下室"]), enabled: false },
      { id: "blank", name: "blank", order: 0, activation: { mode: "keywords", keywords: [] } },
      { id: "spaces", name: "spaces", order: 0, activation: { mode: "keywords", keywords: ["  "] } },
    ];
    expect(matchWorldbookSwitches(odd, "地下室")).toEqual({ on: [], off: [] });
  });

  it("says nothing about a blank message", () => {
    expect(matchWorldbookSwitches(books, "   ")).toEqual({ on: [], off: [] });
  });

  it("returns the same map when nothing moved, so callers can skip the write", () => {
    const before = { a: true };
    expect(applyWorldbookSwitches(before, { on: [], off: [] })).toBe(before);
  });
});

describe("manual modules take a runtime switch", () => {
  const manual: Worldbook[] = [{ id: "m", name: "m", order: 0, activation: { mode: "manual" } }];

  it("default on, because the creator's enable toggle is the default", () => {
    expect([...computeActiveWorldbookIds(manual, state({}))]).toEqual(["m"]);
  });

  it("a switch beats the default in both directions", () => {
    expect([...computeActiveWorldbookIds(manual, state({ m: false }))]).toEqual([]);
    expect([...computeActiveWorldbookIds(manual, state({ m: true }))]).toEqual(["m"]);
  });

  it("never overrides the master enable toggle — off is off", () => {
    const disabled: Worldbook[] = [{ ...manual[0]!, enabled: false }];
    expect([...computeActiveWorldbookIds(disabled, state({ m: true }))]).toEqual([]);
  });

  it("leaves always-on modules alone", () => {
    const always: Worldbook[] = [{ id: "k", name: "k", order: 0, activation: { mode: "always" } }];
    expect([...computeActiveWorldbookIds(always, state({ k: false }))]).toEqual(["k"]);
  });
});

describe("leaving a keyword module", () => {
  const backroom: Worldbook = { id: "back", name: "后仓", order: 0, activation: { mode: "keywords", keywords: ["后仓"], exclusive: true, leaveKeywords: ["回店里", "出来"] } };
  it("a leave word said inside closes it", () => {
    expect(matchWorldbookSwitches([backroom], "我拿完箱子，回店里", { back: true })).toEqual({ on: [], off: ["back"] });
  });
  it("a leave word said outside does nothing", () => {
    expect(matchWorldbookSwitches([backroom], "我回店里", {})).toEqual({ on: [], off: [] });
  });
  it("an enter word in the same message keeps it open", () => {
    expect(matchWorldbookSwitches([backroom], "从后仓出来又钻回后仓", { back: true }).off).toEqual([]);
  });
});
