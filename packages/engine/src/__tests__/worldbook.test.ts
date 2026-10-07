import { describe, it, expect } from "vitest";
import {
  computeActiveWorldbookIds,
  filterEntriesByActiveWorldbooks,
} from "../lorebook/worldbook.js";
import { GameStateManager } from "../state/game-state-manager.js";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import {
  createMockEntry,
  createMockGameState,
  createMockWorld,
  createMockCondition,
} from "./test-utils.js";

const coreBook = {
  id: "core",
  name: "Core",
  activation: { mode: "always" as const },
  order: 0,
};

const tavernBook = {
  id: "tavern",
  name: "Tavern",
  activation: {
    mode: "conditions" as const,
    conditions: [
      createMockCondition({ variableId: "scene", operator: "eq", value: "tavern" }),
    ],
    conditionLogic: "all" as const,
  },
  order: 1,
};

describe("computeActiveWorldbookIds", () => {
  it("always-mode worldbooks are always active", () => {
    const active = computeActiveWorldbookIds([coreBook], createMockGameState({ variables: {} }));
    expect(active.has("core")).toBe(true);
  });

  it("conditions-mode worldbook is active only when its conditions pass", () => {
    const inTavern = computeActiveWorldbookIds(
      [tavernBook],
      createMockGameState({ variables: { scene: "tavern" } }),
    );
    expect(inTavern.has("tavern")).toBe(true);

    const inForest = computeActiveWorldbookIds(
      [tavernBook],
      createMockGameState({ variables: { scene: "forest" } }),
    );
    expect(inForest.has("tavern")).toBe(false);
  });

  it("returns an empty set when there are no worldbooks", () => {
    expect(computeActiveWorldbookIds(undefined, createMockGameState()).size).toBe(0);
  });

  it("skips a worldbook whose master enable toggle is off", () => {
    const off = { id: "off", name: "Off", activation: { mode: "always" as const }, order: 0, enabled: false };
    expect(computeActiveWorldbookIds([off], createMockGameState()).has("off")).toBe(false);
  });

  it("a manual-mode worldbook is active iff its enable toggle is on", () => {
    const on = { id: "m1", name: "Secret", activation: { mode: "manual" as const }, order: 0, enabled: true };
    const off = { id: "m2", name: "Hidden", activation: { mode: "manual" as const }, order: 0, enabled: false };
    const active = computeActiveWorldbookIds([on, off], createMockGameState());
    expect(active.has("m1")).toBe(true);
    expect(active.has("m2")).toBe(false);
  });

  it("greeting-mode worldbook is active when activeGreetingId is in greetingIds", () => {
    const book = {
      id: "mayu-route",
      name: "Mayu Route",
      activation: { mode: "greeting" as const, greetingIds: ["g-a", "g-b"] },
      order: 0,
    };
    const withGreeting = computeActiveWorldbookIds(
      [book],
      createMockGameState({ activeGreetingId: "g-a" }),
    );
    expect(withGreeting.has("mayu-route")).toBe(true);
  });

  it("greeting-mode worldbook is NOT active when activeGreetingId is absent or different", () => {
    const book = {
      id: "mayu-route",
      name: "Mayu Route",
      activation: { mode: "greeting" as const, greetingIds: ["g-a", "g-b"] },
      order: 0,
    };
    const noGreeting = computeActiveWorldbookIds([book], createMockGameState());
    expect(noGreeting.has("mayu-route")).toBe(false);

    const wrongGreeting = computeActiveWorldbookIds(
      [book],
      createMockGameState({ activeGreetingId: "g-c" }),
    );
    expect(wrongGreeting.has("mayu-route")).toBe(false);
  });

  it("activeGreetingId survives GameStateManager normalization (it is NOT a variable)", () => {
    // Regression guard for the original bug: __activeGreeting lived in
    // state.variables and got stripped by normalizeState (undeclared key) → the
    // greeting gate silently went dead on every turn. As a first-class field it
    // must round-trip through a GameStateManager.
    const book = {
      id: "mayu-route",
      name: "Mayu Route",
      activation: { mode: "greeting" as const, greetingIds: ["g-a"] },
      order: 0,
    };
    const world = createMockWorld({ worldbooks: [book] });
    const normalized = new GameStateManager(
      world,
      createMockGameState({ activeGreetingId: "g-a" }),
    ).getSnapshot();
    expect(normalized.activeGreetingId).toBe("g-a");
    expect(computeActiveWorldbookIds([book], normalized).has("mayu-route")).toBe(true);
  });
});

describe("filterEntriesByActiveWorldbooks", () => {
  const coreEntry = createMockEntry({ id: "c1", content: "core lore" }); // no worldbookId
  const tavernEntry = createMockEntry({ id: "t1", content: "tavern lore", worldbookId: "tavern" });

  it("keeps an active worker's persona private while preserving ordinary module lore", () => {
    const worker = { ...coreBook, id: "worker", station: { kind: "worker" as const } };
    const narrator = { ...coreBook, id: "narrator", station: { kind: "narrator" as const } };
    const entries = [coreEntry, ...["core", "worker", "narrator", "missing"].map((id) =>
      createMockEntry({ id, worldbookId: id, alwaysSend: true }),
    )];
    const state = createMockGameState();
    expect(computeActiveWorldbookIds([coreBook, worker, narrator], state).has("worker")).toBe(true);
    expect(filterEntriesByActiveWorldbooks(entries, [coreBook, worker, narrator], state).map((e) => e.id))
      .toEqual(["c1", "core", "narrator", "missing"]);
    // Filtering a player prompt must not remove the worker's source material.
    expect(entries.find((e) => e.id === "worker")?.content).toBe("A brave adventurer.");
  });

  it("does not inject worker instructions through any player lore section", () => {
    const worker = { ...coreBook, id: "worker", station: { kind: "worker" as const } };
    const privateEntries = (["system-presets", "chat-history", "post-history"] as const).map((section) =>
      createMockEntry({ worldbookId: "worker", section, alwaysSend: true, content: "PRIVATE WORKER PERSONA", depth: 0 }),
    );
    const publicEntry = createMockEntry({ alwaysSend: true, content: "PUBLIC NARRATOR" });
    const world = createMockWorld({ worldbooks: [worker], entries: [...privateEntries, publicEntry] });
    const state = createMockGameState();
    const builder = new PromptBuilder();
    const prompt = [
      ...builder.buildSystemMessages(world, state),
      ...builder.buildDepthEntries(world, state, privateEntries),
      ...builder.buildPostHistoryEntries(world, state, privateEntries),
    ];
    expect(prompt.some((entry) => entry.content.includes("PUBLIC NARRATOR"))).toBe(true);
    expect(prompt.some((entry) => entry.content.includes("PRIVATE WORKER PERSONA"))).toBe(false);
  });

  it("keeps Core (no worldbookId) entries regardless of state", () => {
    const kept = filterEntriesByActiveWorldbooks(
      [coreEntry, tavernEntry],
      [coreBook, tavernBook],
      createMockGameState({ variables: { scene: "forest" } }),
    );
    expect(kept.map((e) => e.id)).toEqual(["c1"]);
  });

  it("includes a worldbook's entries only while that worldbook is active", () => {
    const inTavern = filterEntriesByActiveWorldbooks(
      [coreEntry, tavernEntry],
      [coreBook, tavernBook],
      createMockGameState({ variables: { scene: "tavern" } }),
    );
    expect(inTavern.map((e) => e.id).sort()).toEqual(["c1", "t1"]);
  });

  it("treats an entry pointing at an unknown worldbook as Core (fail-open)", () => {
    const orphan = createMockEntry({ id: "o1", worldbookId: "deleted-book" });
    const kept = filterEntriesByActiveWorldbooks([orphan], [coreBook], createMockGameState());
    expect(kept.map((e) => e.id)).toEqual(["o1"]);
  });

  it("returns all entries unchanged when there are no worldbooks", () => {
    const all = filterEntriesByActiveWorldbooks(
      [coreEntry, tavernEntry],
      [],
      createMockGameState(),
    );
    expect(all).toHaveLength(2);
  });
});
