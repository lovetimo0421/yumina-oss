import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GameState, WorldDefinition } from "@yumina/engine";
import { mergeGameStatePatch, normalizeGameState, reconcileTurnState } from "./game-state.js";

// 问道, 2026-09-01: the card's creation screen commits ~60 variables through
// PATCH /sessions/:id/state and then sends its opening message. The turn read
// session state before the later patches committed and, ~40s later, wrote its
// own snapshot back wholesale — session 1dadfb55 kept writes 1..24 and lost
// 25..60 (starter kit, setup-complete, 悟道 tables) the instant the first reply
// persisted. These lock the reconcile that keeps concurrent patches alive.
const worldDef = {
  id: "w1",
  name: "问道",
  variables: [
    { id: "player-name", name: "name", type: "string", defaultValue: "" },
    { id: "player-items", name: "items", type: "json", defaultValue: [] },
    { id: "setup-complete", name: "setup", type: "boolean", defaultValue: false },
    { id: "player-location", name: "location", type: "string", defaultValue: "" },
    { id: "affinity", name: "affinity", type: "number", defaultValue: 0 },
  ],
  entries: [],
  rules: [],
} as unknown as WorldDefinition;

const state = (
  variables: Record<string, unknown>,
  extra: Partial<GameState> = {},
): GameState => normalizeGameState(worldDef, { variables, ...extra });

describe("reconcileTurnState", () => {
  it("ordinary patches preserve opted-in permanent facts without locking normal booleans", () => {
    const world = { ...worldDef, variables: [
      ...worldDef.variables, { id: "ever", name: "Ever", type: "boolean" as const, defaultValue: false, onceTrue: true },
    ] };
    const before = normalizeGameState(world, { variables: { ever: true, "setup-complete": true } });
    const patched = mergeGameStatePatch(world, before, { variables: { ever: false, "setup-complete": false } });
    assert.equal(patched.variables.ever, true);
    assert.equal(patched.variables["setup-complete"], false);
  });
  it("keeps a patch that landed while the turn was streaming", () => {
    // What the turn read at request start (the card was mid-commit).
    const base = state({ "player-name": "cpk" });
    // What the card's remaining PATCHes then wrote to the DB.
    const live = state({
      "player-name": "cpk",
      "player-items": [{ name: "spirit-stone", qty: 25 }],
      "setup-complete": true,
    });
    // The turn's own effect: the AI moved the player.
    const turn = state({ "player-name": "cpk", "player-location": "houtu" });

    const merged = reconcileTurnState(worldDef, live, base, turn);

    assert.deepEqual(merged.variables["player-items"], [{ name: "spirit-stone", qty: 25 }]);
    assert.equal(merged.variables["setup-complete"], true);
    assert.equal(merged.variables["player-location"], "houtu");
  });

  it("lets the turn win on a key it actually changed", () => {
    const base = state({ affinity: 10 });
    const live = state({ affinity: 10, "player-location": "inn" });
    const turn = state({ affinity: 15 });

    const merged = reconcileTurnState(worldDef, live, base, turn);

    assert.equal(merged.variables.affinity, 15);
    assert.equal(merged.variables["player-location"], "inn");
  });

  it("does not resurrect a value the turn deliberately reset to its default", () => {
    const base = state({ "setup-complete": true });
    const live = state({ "setup-complete": true });
    const turn = state({ "setup-complete": false });

    const merged = reconcileTurnState(worldDef, live, base, turn);

    assert.equal(merged.variables["setup-complete"], false);
  });

  it("keeps turn-owned bookkeeping over a patch's stale echo", () => {
    // Every setVariable PATCH replays the client's whole session state, stale
    // turnCount included — that must never roll the turn back.
    const base = state({}, { turnCount: 4 });
    const live = state({ affinity: 3 }, { turnCount: 4 });
    const turn = state({}, { turnCount: 5 });

    const merged = reconcileTurnState(worldDef, live, base, turn);

    assert.equal(merged.turnCount, 5);
    assert.equal(merged.variables.affinity, 3);
  });

  it("clears metadata the turn consumed, keeps metadata a patch added", () => {
    const base = state({}, {
      metadata: { pendingContext: [{ message: "hi", role: "system" }] },
    });
    const live = state({}, {
      metadata: {
        pendingContext: [{ message: "hi", role: "system" }],
        activeLoreSlots: ["slot-a"],
      },
    });
    const turn = state({}, { metadata: { pendingContext: undefined } });

    const merged = reconcileTurnState(worldDef, live, base, turn);

    assert.equal(merged.metadata?.pendingContext, undefined);
    assert.deepEqual(merged.metadata?.activeLoreSlots, ["slot-a"]);
  });

  it("keeps an opening the player switched to mid-turn", () => {
    const base = state({}, { activeGreetingId: "g1" });
    const live = state({}, { activeGreetingId: "g2" });
    const turn = state({}, { activeGreetingId: "g1" });

    assert.equal(reconcileTurnState(worldDef, live, base, turn).activeGreetingId, "g2");
  });

  it("survives a session row with no stored state yet", () => {
    const base = state({});
    const turn = state({ "player-name": "cpk" });

    assert.equal(
      reconcileTurnState(worldDef, undefined, base, turn).variables["player-name"],
      "cpk",
    );
  });
});
