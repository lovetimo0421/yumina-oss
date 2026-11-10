import { describe, it, expect } from "vitest";
import { isRunTrackedModule, memoryPoolMembers, resolveStation } from "../station.js";
import type { Worldbook } from "../../types/index.js";

const book = (over: Partial<Worldbook> & { id: string }): Worldbook => ({
  name: over.id,
  activation: { mode: "always" },
  order: 0,
  ...over,
});

// "A and B share one memory, C and D share another": each narrator belongs
// to a pool. The card's pool is the default and is spelled null; a module
// that keeps to itself is a pool of one; two modules that name the same pool
// see each other's runs and nobody else's.
describe("resolveStation — memory pools", () => {
  it("a narrator is in the card's pool unless it says otherwise", () => {
    expect(resolveStation(book({ id: "d1", station: { kind: "narrator" } }))!.memoryPool).toBeNull();
  });

  it("an explicit pool is kept as named", () => {
    const a = book({ id: "a", station: { kind: "narrator", memoryPool: "pool-a" } });
    const b = book({ id: "b", station: { kind: "narrator", memoryPool: "pool-a" } });
    expect(resolveStation(a)!.memoryPool).toBe("pool-a");
    expect(resolveStation(b)!.memoryPool).toBe("pool-a");
  });

  it("the legacy 'own memory' flag is a pool of one, named after the module", () => {
    const wb = book({ id: "tower", station: { kind: "narrator", onClose: "keep", history: "own" } });
    expect(resolveStation(wb)!.memoryPool).toBe("pool-tower");
    // Still reported the old way for callers that only know the flag.
    expect(resolveStation(wb)!.history).toBe("own");
  });

  it("a pool marks history as 'own' for callers that only know the flag, and is run-tracked", () => {
    const wb = book({ id: "a", station: { kind: "narrator", onClose: "keep", memoryPool: "pool-x" } });
    expect(resolveStation(wb)!.history).toBe("own");
    expect(isRunTrackedModule(wb)).toBe(true);
  });

  it("a worker has no memory of its own to pool", () => {
    const wb = book({ id: "w", station: { kind: "worker", memoryPool: "pool-x" } });
    expect(resolveStation(wb)!.memoryPool).toBeNull();
  });

  it("names every module in a pool, in order", () => {
    const a = book({ id: "a", order: 2, station: { kind: "narrator", memoryPool: "p" } });
    const b = book({ id: "b", order: 1, station: { kind: "narrator", memoryPool: "p" } });
    const c = book({ id: "c", order: 0, station: { kind: "narrator", memoryPool: "q" } });
    const plain = book({ id: "plain", order: 3 });
    expect(memoryPoolMembers([a, b, c, plain], "p").map((x) => x.id)).toEqual(["b", "a"]);
    expect(memoryPoolMembers([a, b, c, plain], "q").map((x) => x.id)).toEqual(["c"]);
    expect(memoryPoolMembers([a, b, c, plain], null)).toEqual([]);
  });
});
