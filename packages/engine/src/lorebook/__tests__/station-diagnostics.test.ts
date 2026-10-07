import { describe, it, expect } from "vitest";
import { diagnoseStation } from "../station-diagnostics.js";
import type { Worldbook } from "../../types/index.js";

const book = (over: Partial<Worldbook> & { id: string }): Worldbook => ({
  name: over.id,
  activation: { mode: "always" },
  order: 0,
  ...over,
});

const codes = (wb: Worldbook, all: Worldbook[]) => diagnoseStation(wb, all).map((d) => d.code);

describe("worker.noInputs — the one that looks finished", () => {
  it("warns when a worker has a task and a trigger but reads nothing", () => {
    const lone = book({
      id: "chronicler",
      station: { kind: "worker", task: "Record what the traveller did.", trigger: { on: "turns", every: 1 } },
    });
    const codes = diagnoseStation(lone, [lone]).map((d) => d.code);
    expect(codes).toContain("worker.noInputs");
    // The two errors are gone, which is exactly why this matters: without it
    // the console goes quiet and the creator believes the worker is wired.
    expect(codes).not.toContain("worker.noTask");
    expect(codes).not.toContain("worker.noTrigger");
  });

  it("goes quiet once something is wired in", () => {
    const source = book({ id: "scene", station: { kind: "narrator", onClose: "archive" } });
    const wired = book({
      id: "chronicler",
      station: {
        kind: "worker",
        task: "Record what the traveller did.",
        trigger: { on: "turns", every: 1 },
        inputs: [{ kind: "transcript", from: "scene", limit: 10 }],
      },
    });
    expect(diagnoseStation(wired, [wired, source]).map((d) => d.code)).not.toContain("worker.noInputs");
  });
});

describe("diagnoseStation — only things that can never work", () => {
  it("says nothing about a plain content module", () => {
    expect(codes(book({ id: "lore" }), [])).toEqual([]);
  });

  it("says nothing about a correctly wired pair", () => {
    const dungeon = book({ id: "d1", name: "副本一", station: { kind: "narrator", onClose: "archive" } });
    const chr = book({
      id: "chr",
      name: "史官",
      order: 1,
      station: {
        kind: "worker",
        task: "写三行",
        trigger: { on: "module-closed", from: "d1" },
        inputs: [{ kind: "memory", from: "d1" }],
      },
    });
    const town = book({
      id: "town",
      name: "副本二",
      order: 2,
      activation: { mode: "conditions", conditions: [], conditionLogic: "all" },
      station: { kind: "narrator", inputs: [{ kind: "worker", from: "chr" }] },
    });
    expect(codes(dungeon, [dungeon, chr, town])).toEqual([]);
    expect(codes(chr, [dungeon, chr, town])).toEqual([]);
    expect(codes(town, [dungeon, chr, town])).toEqual([]);
  });
});

describe("a worker that will never do anything", () => {
  const d1 = book({ id: "d1", station: { kind: "narrator", onClose: "archive" } });

  it("flags a missing task and a missing trigger", () => {
    const chr = book({ id: "chr", station: { kind: "worker" } });
    expect(codes(chr, [d1, chr])).toEqual(["worker.noTask", "worker.noTrigger", "worker.noInputs"]);
  });

  it("flags a trigger on a module that never closes a run", () => {
    // 'keep' means the span never archives, so its close wakes nobody.
    const plain = book({ id: "keeper", name: "常驻", station: { kind: "narrator", onClose: "keep" } });
    const chr = book({
      id: "chr",
      station: { kind: "worker", task: "t", trigger: { on: "module-closed", from: "keeper" } },
    });
    expect(codes(chr, [plain, chr])).toEqual(["worker.noInputs", "trigger.sourceNeverCloses"]);
  });

  it("flags a trigger pointed at a module that is gone", () => {
    const chr = book({
      id: "chr",
      station: { kind: "worker", task: "t", trigger: { on: "module-closed", from: "deleted" } },
    });
    expect(codes(chr, [chr])).toEqual(["worker.noInputs", "trigger.sourceMissing"]);
  });

  it("flags waiting on something that never answers the player", () => {
    const narrator = book({ id: "dock", station: { kind: "narrator" } });
    const other = book({ id: "other", station: { kind: "worker", task: "t", trigger: { on: "turns", every: 3 } } });
    const after = (from: string) => book({ id: "echo", station: { kind: "worker", task: "t", trigger: { on: "after", from } } });
    expect(codes(after("dock"), [narrator, other, after("dock")])).toEqual(["worker.noInputs"]);
    expect(codes(after("other"), [narrator, other, after("other")])).toEqual(["worker.noInputs", "trigger.afterNotAnAi"]);
    expect(codes(after("deleted"), [narrator, after("deleted")])).toEqual(["worker.noInputs", "trigger.afterNotAnAi"]);
  });
});

describe("wires that can never carry anything", () => {
  const plainLore = book({ id: "lore", name: "设定" });

  it("memory from a module that does not archive", () => {
    const town = book({ id: "town", station: { kind: "narrator", inputs: [{ kind: "memory", from: "lore" }] } });
    expect(codes(town, [plainLore, town])).toEqual(["input.memoryFromNonArchiving"]);
  });

  it("transcript from a module that does not archive", () => {
    // Transcript is addressed by run spans, and a module with no runs has none.
    const town = book({
      id: "town",
      station: { kind: "narrator", inputs: [{ kind: "transcript", from: "lore", limit: 5 }] },
    });
    expect(codes(town, [plainLore, town])).toEqual(["input.transcriptFromNonArchiving"]);
  });

  it("worker output from something that is not a worker", () => {
    const town = book({ id: "town", station: { kind: "narrator", inputs: [{ kind: "worker", from: "lore" }] } });
    expect(codes(town, [plainLore, town])).toEqual(["input.workerFromNonWorker"]);
  });

  it("worker output from a worker that never runs is a warning, not an error", () => {
    // It is wired correctly; the problem is one module over, and that module
    // is already shouting about itself.
    const idle = book({ id: "chr", name: "史官", station: { kind: "worker" } });
    const town = book({ id: "town", station: { kind: "narrator", inputs: [{ kind: "worker", from: "chr" }] } });
    const found = diagnoseStation(town, [idle, town]);
    expect(found.map((d) => d.code)).toEqual(["input.workerNeverRuns"]);
    expect(found[0]!.level).toBe("warn");
  });

  it("a source that was deleted", () => {
    const town = book({ id: "town", station: { kind: "narrator", inputs: [{ kind: "memory", from: "gone" }] } });
    expect(codes(town, [town])).toEqual(["input.sourceMissing"]);
  });

  it("core is only addressable by a variables wire", () => {
    const town = book({ id: "town", station: { kind: "narrator", inputs: [{ kind: "memory", from: "core" }] } });
    expect(codes(town, [town])).toEqual(["input.coreOnlyVariables"]);
    const ok = book({ id: "t2", station: { kind: "narrator", inputs: [{ kind: "variables", from: "core" }] } });
    expect(codes(ok, [ok])).toEqual([]);
  });

  it("the card's conversation is read only behind the scenes; a narrator has it already", () => {
    const narrator = book({ id: "up", station: { kind: "narrator", inputs: [{ kind: "transcript", from: "core", limit: 20 }] } });
    expect(codes(narrator, [narrator])).toEqual(["input.coreOnlyVariables"]);
    const recorder = book({ id: "rec", station: { kind: "worker", task: "x", trigger: { on: "turns", every: 3 }, inputs: [{ kind: "transcript", from: "core", limit: 20 }] } });
    expect(codes(recorder, [recorder])).toEqual([]);
  });
});

describe("a narrator nobody will ever hear", () => {
  it("warns when an always-on narrator sits behind another", () => {
    // Only one narrator speaks; the loser looks configured and does nothing.
    const first = book({ id: "a", name: "第一", order: 0, station: { kind: "narrator" } });
    const second = book({ id: "b", name: "第二", order: 1, station: { kind: "narrator" } });
    expect(codes(first, [first, second])).toEqual([]);
    const found = diagnoseStation(second, [first, second]);
    expect(found.map((d) => d.code)).toEqual(["narrator.shadowed"]);
    expect(found[0]!.params?.name).toBe("第一");
  });

  it("does not warn when their activations differ — that is the dungeon pattern", () => {
    const d1 = book({
      id: "d1",
      activation: { mode: "conditions", conditions: [], conditionLogic: "all" },
      station: { kind: "narrator" },
    });
    const d2 = book({
      id: "d2",
      order: 1,
      activation: { mode: "conditions", conditions: [], conditionLogic: "all" },
      station: { kind: "narrator" },
    });
    expect(codes(d2, [d1, d2])).toEqual([]);
  });
});
