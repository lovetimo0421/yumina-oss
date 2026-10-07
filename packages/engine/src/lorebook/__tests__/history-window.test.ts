import { describe, expect, it } from "vitest";
import type { Worldbook } from "../../types";
import { applyHistoryLimit, resolveHistoryLimit, resolveRequestedMaxContext } from "../history-window";

const narrator = (id: string, historyLimit?: number): Worldbook =>
  ({
    id,
    name: id,
    enabled: true,
    activation: { mode: "always" },
    station: { kind: "narrator", ...(historyLimit !== undefined ? { historyLimit } : {}) },
  }) as unknown as Worldbook;

describe("resolveHistoryLimit", () => {
  it("is undefined when neither the card nor a narrating module set one", () => {
    expect(resolveHistoryLimit({ settings: {} as never, worldbooks: [] }, new Set())).toBeUndefined();
  });

  it("uses the card's limit when no narrator overrides it", () => {
    expect(resolveHistoryLimit({ settings: { historyLimit: 10 } as never, worldbooks: [] }, new Set())).toBe(10);
  });

  it("lets the active narrating module win over the card", () => {
    const books = [narrator("dungeon", 4)];
    expect(resolveHistoryLimit({ settings: { historyLimit: 10 } as never, worldbooks: books }, new Set(["dungeon"]))).toBe(4);
  });

  it("falls back to the card when the narrator has no limit of its own", () => {
    const books = [narrator("dungeon")];
    expect(resolveHistoryLimit({ settings: { historyLimit: 10 } as never, worldbooks: books }, new Set(["dungeon"]))).toBe(10);
  });

  it("ignores nonsense and clamps to the ceiling", () => {
    expect(resolveHistoryLimit({ settings: { historyLimit: 0 } as never, worldbooks: [] }, new Set())).toBeUndefined();
    expect(resolveHistoryLimit({ settings: { historyLimit: 99999 } as never, worldbooks: [] }, new Set())).toBe(500);
    expect(resolveHistoryLimit({ settings: { historyLimit: 7.9 } as never, worldbooks: [] }, new Set())).toBe(7);
  });
});

describe("applyHistoryLimit", () => {
  it("keeps the newest rows and never mutates the input", () => {
    const rows = [1, 2, 3, 4, 5];
    expect(applyHistoryLimit(rows, 2)).toEqual([4, 5]);
    expect(rows).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns everything when there is no limit or the history is short", () => {
    expect(applyHistoryLimit([1, 2, 3], undefined)).toEqual([1, 2, 3]);
    expect(applyHistoryLimit([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });
});

describe("resolveRequestedMaxContext", () => {
  it("lets the player override by default", () => {
    expect(resolveRequestedMaxContext({ maxContext: 32000 }, 8000)).toBe(8000);
    expect(resolveRequestedMaxContext({ maxContext: 32000 }, undefined)).toBe(32000);
    expect(resolveRequestedMaxContext(undefined, undefined)).toBe(200000);
  });

  it("keeps the card's number when the author locked it", () => {
    expect(resolveRequestedMaxContext({ maxContext: 32000, contextPolicy: "author" }, 8000)).toBe(32000);
    expect(resolveRequestedMaxContext({ contextPolicy: "author" }, 8000)).toBe(8000);
  });
});
