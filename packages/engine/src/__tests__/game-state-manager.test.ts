import { describe, it, expect, beforeEach, vi } from "vitest";
import { GameStateManager } from "../state/game-state-manager.js";
import {
  createMockVariable,
  createMockWorld,
  createMockGameState,
  createMockEffect,
  resetIdCounter,
} from "./test-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a world with the given variables for quick setup */
function worldWith(...variables: ReturnType<typeof createMockVariable>[]) {
  return createMockWorld({ variables });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GameStateManager", () => {
  beforeEach(() => {
    resetIdCounter();
  });

  // =========================================================================
  // Initialization
  // =========================================================================

  describe("initialization", () => {
    it("initializes variables from world definition defaults", () => {
      const hp = createMockVariable({ id: "hp", name: "HP", type: "number", defaultValue: 100 });
      const name = createMockVariable({ id: "name", name: "Name", type: "string", defaultValue: "Hero" });
      const alive = createMockVariable({ id: "alive", name: "Alive", type: "boolean", defaultValue: true });

      const mgr = new GameStateManager(worldWith(hp, name, alive));

      expect(mgr.get("hp")).toBe(100);
      expect(mgr.get("name")).toBe("Hero");
      expect(mgr.get("alive")).toBe(true);
    });

    it("starts with turnCount 0 when no existing state is given", () => {
      const world = worldWith(createMockVariable({ id: "hp", defaultValue: 50 }));
      const mgr = new GameStateManager(world);

      const snap = mgr.getSnapshot();
      expect(snap.turnCount).toBe(0);
    });

    it("initializes from existing state when provided", () => {
      const hp = createMockVariable({ id: "hp", name: "HP", type: "number", defaultValue: 100 });
      const world = worldWith(hp);

      const existingState = createMockGameState({
        worldId: world.id,
        variables: { hp: 42 },
        turnCount: 7,
        metadata: { checkpoint: "dungeon" },
      });

      const mgr = new GameStateManager(world, existingState);

      expect(mgr.get("hp")).toBe(42);
      expect(mgr.getSnapshot().turnCount).toBe(7);
      expect(mgr.getMetadata("checkpoint")).toBe("dungeon");
    });

    it("backfills missing variables and state fields from the current world", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const morale = createMockVariable({ id: "morale", type: "number", defaultValue: 50 });
      const world = worldWith(hp, morale);

      const existingState = {
        worldId: "older-world-id",
        variables: { hp: 42 },
      } as any;

      const mgr = new GameStateManager(world, existingState);
      const snap = mgr.getSnapshot();

      expect(snap.worldId).toBe(world.id);
      expect(snap.variables).toEqual({ hp: 42, morale: 50 });
      expect(snap.turnCount).toBe(0);
      expect(snap.metadata).toEqual({});
      expect(snap.ruleState).toBeDefined();
    });

    it("returns undefined for unknown variable IDs", () => {
      const mgr = new GameStateManager(worldWith());
      expect(mgr.get("nonexistent")).toBeUndefined();
    });

    it("preserves __lore_{slotId} frontend flags but still strips other undeclared variables", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const world = worldWith(hp);
      const existingState = {
        worldId: world.id,
        variables: { hp: 30, "__lore_secret-codex": true, bogus_undeclared: "x" },
      } as any;

      const snap = new GameStateManager(world, existingState).getSnapshot();

      expect(snap.variables["hp"]).toBe(30);
      // LoreButton's persisted flag survives normalization (the toggle-resets bug).
      expect(snap.variables["__lore_secret-codex"]).toBe(true);
      // Other undeclared variables are still stripped.
      expect(snap.variables["bogus_undeclared"]).toBeUndefined();
    });
  });

  // =========================================================================
  // set() method
  // =========================================================================

  describe("set()", () => {
    it("sets a number variable", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      mgr.set("hp", 75);
      expect(mgr.get("hp")).toBe(75);
    });

    it("sets a string variable", () => {
      const title = createMockVariable({ id: "title", type: "string", defaultValue: "None" });
      const mgr = new GameStateManager(worldWith(title));

      mgr.set("title", "Knight");
      expect(mgr.get("title")).toBe("Knight");
    });

    it("sets a boolean variable", () => {
      const flag = createMockVariable({ id: "flag", type: "boolean", defaultValue: false });
      const mgr = new GameStateManager(worldWith(flag));

      mgr.set("flag", true);
      expect(mgr.get("flag")).toBe(true);
    });

    it("ignores set for unknown variable IDs", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      mgr.set("unknown", 999);
      expect(mgr.get("unknown")).toBeUndefined();
      expect(mgr.get("hp")).toBe(100);
    });

    it("does not notify if value is unchanged", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const listener = vi.fn();
      mgr.onChange(listener);

      mgr.set("hp", 100); // same as default
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Effect operations via applyEffects()
  // =========================================================================

  describe("applyEffects() — set operation", () => {
    it("sets a number variable to an exact value", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "set", value: 50 }),
      ]);

      expect(mgr.get("hp")).toBe(50);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ variableId: "hp", oldValue: 100, newValue: 50 });
    });

    it("sets a string variable to a new value", () => {
      const status = createMockVariable({ id: "status", type: "string", defaultValue: "idle" });
      const mgr = new GameStateManager(worldWith(status));

      mgr.applyEffects([
        createMockEffect({ variableId: "status", operation: "set", value: "fighting" }),
      ]);

      expect(mgr.get("status")).toBe("fighting");
    });

    it("sets a boolean variable", () => {
      const flag = createMockVariable({ id: "flag", type: "boolean", defaultValue: false });
      const mgr = new GameStateManager(worldWith(flag));

      mgr.applyEffects([
        createMockEffect({ variableId: "flag", operation: "set", value: true }),
      ]);

      expect(mgr.get("flag")).toBe(true);
    });
  });

  describe("applyEffects() — add operation", () => {
    it("adds a number to a number variable", () => {
      const gold = createMockVariable({ id: "gold", type: "number", defaultValue: 50 });
      const mgr = new GameStateManager(worldWith(gold));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "gold", operation: "add", value: 25 }),
      ]);

      expect(mgr.get("gold")).toBe(75);
      expect(changes).toEqual([{ variableId: "gold", oldValue: 50, newValue: 75 }]);
    });

    it("no-ops when adding a number to a non-number variable", () => {
      const name = createMockVariable({ id: "name", type: "string", defaultValue: "Hero" });
      const mgr = new GameStateManager(worldWith(name));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "name", operation: "add", value: 10 }),
      ]);

      expect(mgr.get("name")).toBe("Hero");
      expect(changes).toHaveLength(0);
    });
  });

  describe("applyEffects() — subtract operation", () => {
    it("subtracts a number from a number variable", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "subtract", value: 30 }),
      ]);

      expect(mgr.get("hp")).toBe(70);
      expect(changes).toEqual([{ variableId: "hp", oldValue: 100, newValue: 70 }]);
    });

    it("can subtract into negative values when no min is set", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 10 });
      const mgr = new GameStateManager(worldWith(hp));

      mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "subtract", value: 50 }),
      ]);

      expect(mgr.get("hp")).toBe(-40);
    });

    it("no-ops when subtracting from a non-number variable", () => {
      const flag = createMockVariable({ id: "flag", type: "boolean", defaultValue: true });
      const mgr = new GameStateManager(worldWith(flag));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "flag", operation: "subtract", value: 1 }),
      ]);

      expect(mgr.get("flag")).toBe(true);
      expect(changes).toHaveLength(0);
    });
  });

  describe("applyEffects() — multiply operation", () => {
    it("multiplies a number variable by a factor", () => {
      const dmg = createMockVariable({ id: "dmg", type: "number", defaultValue: 20 });
      const mgr = new GameStateManager(worldWith(dmg));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "dmg", operation: "multiply", value: 3 }),
      ]);

      expect(mgr.get("dmg")).toBe(60);
      expect(changes).toEqual([{ variableId: "dmg", oldValue: 20, newValue: 60 }]);
    });

    it("multiplying by zero sets to zero", () => {
      const score = createMockVariable({ id: "score", type: "number", defaultValue: 500 });
      const mgr = new GameStateManager(worldWith(score));

      mgr.applyEffects([
        createMockEffect({ variableId: "score", operation: "multiply", value: 0 }),
      ]);

      expect(mgr.get("score")).toBe(0);
    });

    it("multiplying by a decimal produces fractional results", () => {
      const val = createMockVariable({ id: "val", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(val));

      mgr.applyEffects([
        createMockEffect({ variableId: "val", operation: "multiply", value: 0.5 }),
      ]);

      expect(mgr.get("val")).toBe(50);
    });

    it("no-ops when multiplying a non-number variable", () => {
      const label = createMockVariable({ id: "label", type: "string", defaultValue: "test" });
      const mgr = new GameStateManager(worldWith(label));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "label", operation: "multiply", value: 2 }),
      ]);

      expect(mgr.get("label")).toBe("test");
      expect(changes).toHaveLength(0);
    });
  });

  describe("applyEffects() — toggle operation", () => {
    it("toggles a boolean from false to true", () => {
      const stealth = createMockVariable({ id: "stealth", type: "boolean", defaultValue: false });
      const mgr = new GameStateManager(worldWith(stealth));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "stealth", operation: "toggle", value: true /* value is ignored */ }),
      ]);

      expect(mgr.get("stealth")).toBe(true);
      expect(changes).toEqual([{ variableId: "stealth", oldValue: false, newValue: true }]);
    });

    it("toggles a boolean from true to false", () => {
      const visible = createMockVariable({ id: "visible", type: "boolean", defaultValue: true });
      const mgr = new GameStateManager(worldWith(visible));

      mgr.applyEffects([
        createMockEffect({ variableId: "visible", operation: "toggle", value: false }),
      ]);

      expect(mgr.get("visible")).toBe(false);
    });

    it("no-ops when toggling a non-boolean variable", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "toggle", value: true }),
      ]);

      expect(mgr.get("hp")).toBe(100);
      expect(changes).toHaveLength(0);
    });
  });

  describe("applyEffects() — append operation", () => {
    it("appends a string to a string variable", () => {
      const log = createMockVariable({ id: "log", type: "string", defaultValue: "Day 1: " });
      const mgr = new GameStateManager(worldWith(log));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "log", operation: "append", value: "Entered the cave." }),
      ]);

      expect(mgr.get("log")).toBe("Day 1: Entered the cave.");
      expect(changes).toEqual([
        { variableId: "log", oldValue: "Day 1: ", newValue: "Day 1: Entered the cave." },
      ]);
    });

    it("no-ops when appending to a non-string variable", () => {
      const count = createMockVariable({ id: "count", type: "number", defaultValue: 5 });
      const mgr = new GameStateManager(worldWith(count));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "count", operation: "append", value: "text" }),
      ]);

      expect(mgr.get("count")).toBe(5);
      expect(changes).toHaveLength(0);
    });
  });

  // =========================================================================
  // Multiple effects in one call
  // =========================================================================

  describe("applyEffects() — multiple effects", () => {
    it("applies multiple effects sequentially and returns all changes", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const gold = createMockVariable({ id: "gold", type: "number", defaultValue: 0 });
      const mgr = new GameStateManager(worldWith(hp, gold));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "subtract", value: 20 }),
        createMockEffect({ variableId: "gold", operation: "add", value: 50 }),
      ]);

      expect(mgr.get("hp")).toBe(80);
      expect(mgr.get("gold")).toBe(50);
      expect(changes).toHaveLength(2);
    });

    it("applies effects sequentially so later effects see earlier results", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "subtract", value: 60 }),
        createMockEffect({ variableId: "hp", operation: "add", value: 10 }),
      ]);

      // 100 - 60 = 40, then 40 + 10 = 50
      expect(mgr.get("hp")).toBe(50);
      expect(changes).toHaveLength(2);
      expect(changes[0]).toEqual({ variableId: "hp", oldValue: 100, newValue: 40 });
      expect(changes[1]).toEqual({ variableId: "hp", oldValue: 40, newValue: 50 });
    });

    it("skips effects targeting unknown variables", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "unknown", operation: "set", value: 999 }),
        createMockEffect({ variableId: "hp", operation: "subtract", value: 10 }),
      ]);

      expect(mgr.get("hp")).toBe(90);
      expect(changes).toHaveLength(1);
    });

    it("returns empty array when no changes occur", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "set", value: 100 }),
      ]);

      expect(changes).toHaveLength(0);
    });
  });

  // =========================================================================
  // Min/Max clamping
  // =========================================================================

  describe("min/max clamping", () => {
    it("clamps to min when value goes below", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100, min: 0, max: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "subtract", value: 200 }),
      ]);

      expect(mgr.get("hp")).toBe(0);
    });

    it("clamps to max when value goes above", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 50, min: 0, max: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "add", value: 200 }),
      ]);

      expect(mgr.get("hp")).toBe(100);
    });

    it("clamps with set() as well", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 50, min: 0, max: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      mgr.set("hp", -50);
      expect(mgr.get("hp")).toBe(0);

      mgr.set("hp", 999);
      expect(mgr.get("hp")).toBe(100);
    });

    it("clamps on multiply", () => {
      const dmg = createMockVariable({ id: "dmg", type: "number", defaultValue: 30, min: 0, max: 50 });
      const mgr = new GameStateManager(worldWith(dmg));

      mgr.applyEffects([
        createMockEffect({ variableId: "dmg", operation: "multiply", value: 3 }),
      ]);

      // 30 * 3 = 90, clamped to 50
      expect(mgr.get("dmg")).toBe(50);
    });

    it("works with min only (no max)", () => {
      const score = createMockVariable({ id: "score", type: "number", defaultValue: 10, min: 0 });
      const mgr = new GameStateManager(worldWith(score));

      mgr.applyEffects([
        createMockEffect({ variableId: "score", operation: "subtract", value: 100 }),
      ]);

      expect(mgr.get("score")).toBe(0);
    });

    it("works with max only (no min)", () => {
      const level = createMockVariable({ id: "level", type: "number", defaultValue: 5, max: 10 });
      const mgr = new GameStateManager(worldWith(level));

      mgr.applyEffects([
        createMockEffect({ variableId: "level", operation: "add", value: 100 }),
      ]);

      expect(mgr.get("level")).toBe(10);
    });

    it("reports clamped value in changes array", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 80, min: 0, max: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "add", value: 50 }),
      ]);

      expect(changes).toEqual([{ variableId: "hp", oldValue: 80, newValue: 100 }]);
    });

    it("reports no change when clamped value equals current value", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 0, min: 0, max: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "subtract", value: 10 }),
      ]);

      // 0 - 10 = -10, clamped to 0, same as before -> no change
      expect(mgr.get("hp")).toBe(0);
      expect(changes).toHaveLength(0);
    });
  });

  // =========================================================================
  // Observer pattern
  // =========================================================================

  describe("observer notification", () => {
    it("notifies observer on set()", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const listener = vi.fn();
      mgr.onChange(listener);

      mgr.set("hp", 80);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith("hp", 100, 80);
    });

    it("notifies observer for each change in applyEffects()", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const gold = createMockVariable({ id: "gold", type: "number", defaultValue: 0 });
      const mgr = new GameStateManager(worldWith(hp, gold));

      const listener = vi.fn();
      mgr.onChange(listener);

      mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "subtract", value: 20 }),
        createMockEffect({ variableId: "gold", operation: "add", value: 100 }),
      ]);

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledWith("hp", 100, 80);
      expect(listener).toHaveBeenCalledWith("gold", 0, 100);
    });

    it("supports multiple concurrent observers", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const listener1 = vi.fn();
      const listener2 = vi.fn();
      mgr.onChange(listener1);
      mgr.onChange(listener2);

      mgr.set("hp", 50);

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it("does not notify after observer is deregistered", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const listener = vi.fn();
      const unsubscribe = mgr.onChange(listener);

      mgr.set("hp", 80);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      mgr.set("hp", 60);
      expect(listener).toHaveBeenCalledTimes(1); // still 1, not called again
    });

    it("does not notify for no-op effects", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 0, min: 0 });
      const mgr = new GameStateManager(worldWith(hp));

      const listener = vi.fn();
      mgr.onChange(listener);

      mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "subtract", value: 10 }),
      ]);

      // 0 - 10 = -10, clamped to 0, no actual change
      expect(listener).not.toHaveBeenCalled();
    });

    it("only deregisters the specific observer, not others", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const unsub1 = mgr.onChange(listener1);
      mgr.onChange(listener2);

      unsub1();

      mgr.set("hp", 50);

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // Snapshot / Restore
  // =========================================================================

  describe("snapshot/restore round-trip", () => {
    it("getSnapshot returns a copy of the current state", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const snap = mgr.getSnapshot();

      expect(snap.variables.hp).toBe(100);
      expect(snap.turnCount).toBe(0);
    });

    it("snapshot is a deep copy — modifying it does not affect manager state", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const snap = mgr.getSnapshot();
      snap.variables.hp = 0;
      snap.turnCount = 999;

      expect(mgr.get("hp")).toBe(100);
      expect(mgr.getSnapshot().turnCount).toBe(0);
    });

    it("loadSnapshot restores state from a previously saved snapshot", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const gold = createMockVariable({ id: "gold", type: "number", defaultValue: 50 });
      const mgr = new GameStateManager(worldWith(hp, gold));

      // Save initial state
      const initialSnap = mgr.getSnapshot();

      // Mutate state
      mgr.set("hp", 30);
      mgr.set("gold", 200);
      mgr.incrementTurn();
      mgr.incrementTurn();

      expect(mgr.get("hp")).toBe(30);
      expect(mgr.get("gold")).toBe(200);
      expect(mgr.getSnapshot().turnCount).toBe(2);

      // Restore
      mgr.loadSnapshot(initialSnap);

      expect(mgr.get("hp")).toBe(100);
      expect(mgr.get("gold")).toBe(50);
      expect(mgr.getSnapshot().turnCount).toBe(0);
    });

    it("loadSnapshot does not share references with the provided state object", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const externalState = createMockGameState({
        worldId: "w1",
        variables: { hp: 75 },
        turnCount: 5,
      });

      mgr.loadSnapshot(externalState);

      // Mutate the external object after loading
      externalState.variables.hp = 0;
      externalState.turnCount = 999;

      // Manager should not be affected
      expect(mgr.get("hp")).toBe(75);
      expect(mgr.getSnapshot().turnCount).toBe(5);
    });

    it("loadSnapshot backfills variables that were added after the snapshot was created", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const morale = createMockVariable({ id: "morale", type: "number", defaultValue: 50 });
      const world = worldWith(hp, morale);
      const mgr = new GameStateManager(world);

      mgr.loadSnapshot({
        worldId: "legacy-world",
        variables: { hp: 90 },
        turnCount: 4,
        metadata: {},
      } as any);

      expect(mgr.getSnapshot().worldId).toBe(world.id);
      expect(mgr.get("hp")).toBe(90);
      expect(mgr.get("morale")).toBe(50);
      expect(mgr.getSnapshot().turnCount).toBe(4);
    });

    it("applies effects to variables that are missing from legacy snapshots", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const morale = createMockVariable({ id: "morale", type: "number", defaultValue: 50 });
      const mgr = new GameStateManager(
        worldWith(hp, morale),
        {
          worldId: "legacy-world",
          variables: { hp: 100 },
          turnCount: 1,
          metadata: {},
        } as any
      );

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "morale", operation: "add", value: 10 }),
      ]);

      expect(mgr.get("morale")).toBe(60);
      expect(changes).toEqual([{ variableId: "morale", oldValue: 50, newValue: 60 }]);
    });

    it("round-trips through snapshot correctly with metadata", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      mgr.setMetadata("quest", "dragon_slayer");
      mgr.setMetadata("difficulty", 3);

      const snap = mgr.getSnapshot();

      // Create a new manager and load the snapshot
      const mgr2 = new GameStateManager(worldWith(hp));
      mgr2.loadSnapshot(snap);

      expect(mgr2.getMetadata("quest")).toBe("dragon_slayer");
      expect(mgr2.getMetadata("difficulty")).toBe(3);
    });
  });

  // =========================================================================
  // Turn counter
  // =========================================================================

  describe("turn counter", () => {
    it("incrementTurn increases turnCount by 1", () => {
      const mgr = new GameStateManager(worldWith());

      expect(mgr.getSnapshot().turnCount).toBe(0);

      mgr.incrementTurn();
      expect(mgr.getSnapshot().turnCount).toBe(1);

      mgr.incrementTurn();
      expect(mgr.getSnapshot().turnCount).toBe(2);

      mgr.incrementTurn();
      expect(mgr.getSnapshot().turnCount).toBe(3);
    });

    it("turnCount is preserved across snapshot/restore", () => {
      const mgr = new GameStateManager(worldWith());

      mgr.incrementTurn();
      mgr.incrementTurn();
      mgr.incrementTurn();

      const snap = mgr.getSnapshot();
      expect(snap.turnCount).toBe(3);

      mgr.incrementTurn();
      mgr.incrementTurn();
      expect(mgr.getSnapshot().turnCount).toBe(5);

      mgr.loadSnapshot(snap);
      expect(mgr.getSnapshot().turnCount).toBe(3);
    });
  });

  // =========================================================================
  // Metadata
  // =========================================================================

  describe("metadata", () => {
    it("stores and retrieves metadata values", () => {
      const mgr = new GameStateManager(worldWith());

      mgr.setMetadata("foo", "bar");
      expect(mgr.getMetadata("foo")).toBe("bar");
    });

    it("returns undefined for non-existent metadata keys", () => {
      const mgr = new GameStateManager(worldWith());
      expect(mgr.getMetadata("missing")).toBeUndefined();
    });

    it("overwrites metadata values", () => {
      const mgr = new GameStateManager(worldWith());

      mgr.setMetadata("key", "first");
      mgr.setMetadata("key", "second");

      expect(mgr.getMetadata("key")).toBe("second");
    });
  });

  // =========================================================================
  // Type coercion edge cases
  // =========================================================================

  describe("type coercion edge cases", () => {
    it("add with mismatched types (string value + number variable) is a no-op", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "add", value: "ten" as any }),
      ]);

      expect(mgr.get("hp")).toBe(100);
      expect(changes).toHaveLength(0);
    });

    it("subtract with mismatched types is a no-op", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "subtract", value: "five" as any }),
      ]);

      expect(mgr.get("hp")).toBe(100);
      expect(changes).toHaveLength(0);
    });

    it("multiply with mismatched types is a no-op", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "multiply", value: "two" as any }),
      ]);

      expect(mgr.get("hp")).toBe(100);
      expect(changes).toHaveLength(0);
    });

    it("append with number value on string variable is a no-op", () => {
      const log = createMockVariable({ id: "log", type: "string", defaultValue: "Start" });
      const mgr = new GameStateManager(worldWith(log));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "log", operation: "append", value: 42 as any }),
      ]);

      expect(mgr.get("log")).toBe("Start");
      expect(changes).toHaveLength(0);
    });

    it("toggle on a number variable is a no-op", () => {
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "toggle", value: true }),
      ]);

      expect(mgr.get("hp")).toBe(100);
      expect(changes).toHaveLength(0);
    });

    it("toggle on a string variable is a no-op", () => {
      const name = createMockVariable({ id: "name", type: "string", defaultValue: "Hero" });
      const mgr = new GameStateManager(worldWith(name));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "name", operation: "toggle", value: true }),
      ]);

      expect(mgr.get("name")).toBe("Hero");
      expect(changes).toHaveLength(0);
    });

    it("set operation can change type of value (no type enforcement on set)", () => {
      // The set operation directly assigns the value regardless of type match.
      // Clamping only applies to number variables with number values.
      const hp = createMockVariable({ id: "hp", type: "number", defaultValue: 100 });
      const mgr = new GameStateManager(worldWith(hp));

      mgr.applyEffects([
        createMockEffect({ variableId: "hp", operation: "set", value: "broken" as any }),
      ]);

      // set assigns directly (no type guard in set operation)
      expect(mgr.get("hp")).toBe("broken");
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("handles empty effects array", () => {
      const mgr = new GameStateManager(worldWith());
      const changes = mgr.applyEffects([]);
      expect(changes).toEqual([]);
    });

    it("handles world with no variables", () => {
      const mgr = new GameStateManager(worldWith());
      const snap = mgr.getSnapshot();
      expect(snap.variables).toEqual({});
    });

    it("worldId is set correctly from world definition", () => {
      const world = createMockWorld({ id: "my-world-123" });
      const mgr = new GameStateManager(world);
      expect(mgr.getSnapshot().worldId).toBe("my-world-123");
    });

    it("double toggle restores original boolean value", () => {
      const flag = createMockVariable({ id: "flag", type: "boolean", defaultValue: true });
      const mgr = new GameStateManager(worldWith(flag));

      mgr.applyEffects([
        createMockEffect({ variableId: "flag", operation: "toggle", value: true }),
        createMockEffect({ variableId: "flag", operation: "toggle", value: true }),
      ]);

      expect(mgr.get("flag")).toBe(true);
    });

    it("many sequential appends accumulate correctly", () => {
      const log = createMockVariable({ id: "log", type: "string", defaultValue: "" });
      const mgr = new GameStateManager(worldWith(log));

      mgr.applyEffects([
        createMockEffect({ variableId: "log", operation: "append", value: "A" }),
        createMockEffect({ variableId: "log", operation: "append", value: "B" }),
        createMockEffect({ variableId: "log", operation: "append", value: "C" }),
      ]);

      expect(mgr.get("log")).toBe("ABC");
    });
  });
  // =========================================================================
  // json variables: a list/object must not be overwritten by a bare scalar
  // =========================================================================

  describe("applyEffects() — json shape guard", () => {
    const inventoryWith = (defaultValue: unknown) =>
      createMockVariable({ id: "items", name: "Items", type: "json", defaultValue: defaultValue as never });

    it("refuses to replace a list with a bare string (the inventory-wipe case)", () => {
      const mgr = new GameStateManager(worldWith(inventoryWith([{ name: "Sword" }])));

      const changes = mgr.applyEffects([
        createMockEffect({ variableId: "items", operation: "set", value: "delete 1, delete 0" }),
      ]);

      expect(changes).toEqual([]);
      expect(mgr.get("items")).toEqual([{ name: "Sword" }]);
      expect(mgr.drainRejectedWrites()).toEqual([
        { variableId: "items", value: "delete 1, delete 0" },
      ]);
      expect(mgr.drainRejectedWrites()).toEqual([]);
    });

    it("refuses a bare scalar over an empty list too", () => {
      const mgr = new GameStateManager(worldWith(inventoryWith([])));

      mgr.applyEffects([createMockEffect({ variableId: "items", operation: "set", value: "clear" })]);

      expect(mgr.get("items")).toEqual([]);
    });

    it("repairs a stringified list instead of refusing it", () => {
      const mgr = new GameStateManager(worldWith(inventoryWith([{ name: "Sword" }])));

      mgr.applyEffects([
        createMockEffect({ variableId: "items", operation: "set", value: '[{"name":"Rope"}]' }),
      ]);

      expect(mgr.get("items")).toEqual([{ name: "Rope" }]);
      expect(mgr.drainRejectedWrites()).toEqual([]);
    });

    it("still allows a real list to replace a list", () => {
      const mgr = new GameStateManager(worldWith(inventoryWith([{ name: "Sword" }])));

      mgr.applyEffects([
        createMockEffect({ variableId: "items", operation: "set", value: [{ name: "Rope" }] }),
      ]);

      expect(mgr.get("items")).toEqual([{ name: "Rope" }]);
    });

    it("leaves json variables that legitimately hold a scalar alone", () => {
      const mgr = new GameStateManager(worldWith(inventoryWith("free-form")));

      mgr.applyEffects([createMockEffect({ variableId: "items", operation: "set", value: "still text" })]);

      expect(mgr.get("items")).toBe("still text");
      expect(mgr.drainRejectedWrites()).toEqual([]);
    });

    it("guards set() the same way applyEffects() is guarded", () => {
      const mgr = new GameStateManager(worldWith(inventoryWith([{ name: "Sword" }])));

      mgr.set("items", "clear" as never);

      expect(mgr.get("items")).toEqual([{ name: "Sword" }]);
      expect(mgr.drainRejectedWrites()).toHaveLength(1);
    });
  });
});
