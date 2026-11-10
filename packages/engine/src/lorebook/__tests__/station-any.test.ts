import { describe, it, expect } from "vitest";
import { ANY_MODULE, resolveInputs } from "../station.js";
import { diagnoseStation } from "../station-diagnostics.js";
import type { Worldbook } from "../../types/index.js";

/**
 * 多史馆 — a card where every dungeon keeps its own record, and the records
 * can read each other.
 *
 * Wiring that by hand is twenty-one wires into a station the schema caps at
 * twelve, so "all of them" has to be sayable in one. These pin what `*` may
 * address and, just as importantly, what it may not.
 */

const book = (over: Partial<Worldbook> & { id: string }): Worldbook => ({
  name: over.id,
  activation: { mode: "always" },
  order: 0,
  ...over,
});

const dungeon = (id: string) =>
  book({ id, station: { kind: "narrator", onClose: "archive", memoryPool: `pool-${id}` } });

const chronicler = (id: string, inputs: Worldbook["station"] extends infer _ ? any[] : never = []) =>
  book({
    id,
    station: { kind: "worker", task: "写三行", trigger: { on: "module-closed", from: ANY_MODULE }, inputs },
  });

describe("resolveInputs — which kinds may address a role", () => {
  it("memory and worker may say 'all of them'", () => {
    const archivist = chronicler("head", [
      { kind: "memory", from: ANY_MODULE, as: "lore" },
      { kind: "worker", from: ANY_MODULE, as: "lore" },
    ]);
    const books = [dungeon("d1"), dungeon("d2"), chronicler("c1"), archivist];
    expect(resolveInputs(archivist, books).map((i) => i.kind)).toEqual(["memory", "worker"]);
  });

  it("transcript and variables may not — every dungeon's raw words at once is the prompt this model exists to avoid", () => {
    const greedy = chronicler("head", [
      { kind: "transcript", from: ANY_MODULE, limit: 20 },
      { kind: "variables", from: ANY_MODULE },
    ]);
    expect(resolveInputs(greedy, [dungeon("d1"), greedy])).toEqual([]);
  });

  it("a station never reads itself, wildcard or not", () => {
    const solo = chronicler("only", [{ kind: "worker", from: ANY_MODULE, as: "lore" }]);
    // The wire survives resolution — "every other worker" is a legal thing to
    // ask for on a card that has none yet — and answers empty at read time.
    expect(resolveInputs(solo, [dungeon("d1"), solo])).toHaveLength(1);
  });
});

describe("diagnoseStation — a role nobody answers", () => {
  it("'whoever just closed' on a card where nothing closes is an error", () => {
    const worker = chronicler("c1");
    const never = book({ id: "town", station: { kind: "narrator", onClose: "keep" } });
    const codes = diagnoseStation(worker, [never, worker]).map((d) => d.code);
    expect(codes).toContain("trigger.noClosingModules");
  });

  it("...and is silent as soon as one module archives", () => {
    const worker = chronicler("c1");
    const codes = diagnoseStation(worker, [dungeon("d1"), worker]).map((d) => d.code);
    expect(codes).not.toContain("trigger.noClosingModules");
  });

  it("a wildcard on a kind that cannot answer it is reported, not silently dropped", () => {
    const greedy = chronicler("c1", [{ kind: "transcript", from: ANY_MODULE, limit: 20 }]);
    const codes = diagnoseStation(greedy, [dungeon("d1"), greedy]).map((d) => d.code);
    expect(codes).toContain("input.anyUnsupported");
  });

  it("the only worker on the card reading 'every other worker' is warned, not blocked", () => {
    const solo = chronicler("c1", [{ kind: "worker", from: ANY_MODULE, as: "lore" }]);
    const found = diagnoseStation(solo, [dungeon("d1"), solo]);
    expect(found.find((d) => d.code === "input.anyNoWorkers")?.level).toBe("warn");
  });

  it("reading every archive on a card with no archive is an error", () => {
    const worker = chronicler("c1", [{ kind: "memory", from: ANY_MODULE, as: "lore" }]);
    const never = book({ id: "town", station: { kind: "narrator", onClose: "keep" } });
    const codes = diagnoseStation(worker, [never, worker]).map((d) => d.code);
    expect(codes).toContain("input.anyNoArchiving");
  });
});
