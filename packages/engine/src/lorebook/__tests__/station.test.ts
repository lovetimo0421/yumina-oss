import { describe, it, expect } from "vitest";
import {
  activeNarrator,
  isArchivingModule,
  resolveInputs,
  resolveStation,
  workerModules,
} from "../station.js";
import type { Worldbook } from "../../types/index.js";

const book = (over: Partial<Worldbook> & { id: string }): Worldbook => ({
  name: over.id,
  activation: { mode: "always" },
  order: 0,
  ...over,
});

describe("resolveStation — the back-compat guarantee", () => {
  it("a plain module is not a station", () => {
    // This is the case that matters most: every card in the library is this
    // one. If it ever resolves to a station, every module on every card starts
    // archiving its history and answering with its own model.
    expect(resolveStation(book({ id: "lore" }))).toBeNull();
    expect(resolveStation(book({ id: "lore", note: "x", color: "red" }))).toBeNull();
    expect(isArchivingModule(book({ id: "lore" }))).toBe(false);
  });

  it("survives undefined and null without a guard at every call site", () => {
    expect(resolveStation(undefined)).toBeNull();
    expect(resolveStation(null)).toBeNull();
    expect(isArchivingModule(undefined)).toBe(false);
  });

  it("ignores a station whose kind is not one this build knows", () => {
    // Stored cards outlive the types that described them. A card written by a
    // later build must not turn into a half-configured station in this one.
    const wb = book({ id: "x", station: { kind: "oracle" as never } });
    expect(resolveStation(wb)).toBeNull();
  });
});

describe("resolveStation — a module IS a run", () => {
  it("a narrator archives its span on close unless told otherwise", () => {
    const wb = book({ id: "d1", station: { kind: "narrator" } });
    expect(resolveStation(wb)!.onClose).toBe("archive");
    expect(isArchivingModule(wb)).toBe(true);
  });

  it("…and keeps it when the creator says keep", () => {
    const wb = book({ id: "d1", station: { kind: "narrator", onClose: "keep" } });
    expect(isArchivingModule(wb)).toBe(false);
  });

  it("a worker never archives — it has no span of player messages", () => {
    const wb = book({ id: "w", station: { kind: "worker", onClose: "archive" } });
    expect(resolveStation(wb)!.onClose).toBe("keep");
    expect(isArchivingModule(wb)).toBe(false);
  });
});

describe("resolveStation — legacy cards still open", () => {
  it("runScoped becomes an archiving narrator", () => {
    const wb = book({ id: "d1", runScoped: true, runSummaryPrompt: "记死因" });
    const station = resolveStation(wb)!;
    expect(station.kind).toBe("narrator");
    expect(station.onClose).toBe("archive");
    expect(station.archivePrompt).toBe("记死因");
  });

  it("memorySubscriptions become memory inputs", () => {
    const wb = book({
      id: "town",
      memorySubscriptions: [{ sourceBookId: "d1", as: "lore", limit: 3 }],
    });
    expect(resolveStation(wb)!.inputs).toEqual([
      { kind: "memory", from: "d1", as: "lore", limit: 3 },
    ]);
  });

  it("a subscription with no source is dropped rather than injected as junk", () => {
    const wb = book({
      id: "town",
      memorySubscriptions: [{ sourceBookId: "" }, { sourceBookId: "d1" }],
    });
    expect(resolveStation(wb)!.inputs).toEqual([{ kind: "memory", from: "d1" }]);
  });

  it("an explicit station wins over the legacy fields entirely", () => {
    const wb = book({
      id: "d1",
      runScoped: true,
      memorySubscriptions: [{ sourceBookId: "old" }],
      station: { kind: "narrator", onClose: "keep", inputs: [{ kind: "memory", from: "new" }] },
    });
    const station = resolveStation(wb)!;
    expect(station.onClose).toBe("keep");
    expect(station.inputs).toEqual([{ kind: "memory", from: "new" }]);
  });
});

describe("activeNarrator — exactly one voice", () => {
  const d1 = book({ id: "d1", order: 1, station: { kind: "narrator" } });
  const d2 = book({ id: "d2", order: 2, station: { kind: "narrator" } });
  const lore = book({ id: "lore", order: 0 });

  it("is nobody on a card that has never heard of stations", () => {
    // The whole back-compat story in one assertion: no station, no narrator,
    // and the caller falls through to the session's own model.
    expect(activeNarrator([lore], new Set(["lore"]))).toBeNull();
  });

  it("picks the active narrator", () => {
    expect(activeNarrator([lore, d1, d2], new Set(["lore", "d2"]))!.id).toBe("d2");
  });

  it("picks by order when two narrators are active, deterministically", () => {
    // A revert replays the same state; it must reach the same narrator or the
    // replayed turn is a different turn.
    const first = activeNarrator([d2, d1], new Set(["d1", "d2"]))!.id;
    const second = activeNarrator([d1, d2], new Set(["d2", "d1"]))!.id;
    expect(first).toBe("d1");
    expect(second).toBe("d1");
  });

  it("ignores narrators that are not active", () => {
    expect(activeNarrator([d1, d2], new Set([]))).toBeNull();
  });
});

describe("workerModules", () => {
  it("lists workers and skips disabled ones", () => {
    const on = book({ id: "w1", station: { kind: "worker" } });
    const off = book({ id: "w2", enabled: false, station: { kind: "worker" } });
    const narrator = book({ id: "d1", station: { kind: "narrator" } });
    expect(workerModules([on, off, narrator]).map((w) => w.id)).toEqual(["w1"]);
  });

  it("runs a worker whose activation never matches - activation is not its switch", () => {
    // A worker is reached by its trigger, never by being "open": this function
    // takes no active set at all, and filterEntriesByActiveWorldbooks drops a
    // worker's entries from the narrator's prompt whether it is active or not.
    // That is why the editor hides the activation control on a worker - it
    // would be a dial wired to nothing. If a worker ever does start reading
    // its activation, ModuleActivationEditor has to show the control again.
    const keyworded = book({
      id: "w1",
      station: { kind: "worker" },
      activation: { mode: "keywords", keywords: ["never-said"], exclusive: true },
    });
    const manual = book({ id: "w2", station: { kind: "worker" }, activation: { mode: "manual" } });
    expect(workerModules([keyworded, manual]).map((w) => w.id)).toEqual(["w1", "w2"]);
  });
});

describe("resolveInputs — dead wiring is dropped, not thrown", () => {
  const chronicler = book({ id: "chr", station: { kind: "worker" } });

  it("drops an input pointing at a module that no longer exists", () => {
    // Deleting a module must cost the briefing, not the session.
    const town = book({
      id: "town",
      station: { kind: "narrator", inputs: [{ kind: "memory", from: "deleted" }, { kind: "worker", from: "chr" }] },
    });
    expect(resolveInputs(town, [town, chronicler])).toEqual([{ kind: "worker", from: "chr" }]);
  });

  it("drops self-reference", () => {
    const town = book({
      id: "town",
      station: { kind: "narrator", inputs: [{ kind: "memory", from: "town" }] },
    });
    expect(resolveInputs(town, [town])).toEqual([]);
  });

  it("keeps core as a source", () => {
    const town = book({
      id: "town",
      station: { kind: "narrator", inputs: [{ kind: "variables", from: "core" }] },
    });
    expect(resolveInputs(town, [town])).toEqual([{ kind: "variables", from: "core" }]);
  });

  it("a plain module draws nothing", () => {
    expect(resolveInputs(book({ id: "lore" }), [])).toEqual([]);
  });
});
