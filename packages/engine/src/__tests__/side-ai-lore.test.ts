import { describe, it, expect } from "vitest";
import { sendsEveryTurn } from "../lorebook/entry-triggers.js";

const entry = (over: Record<string, unknown> = {}) => ({
  id: "e", alwaysSend: true, keywords: [] as string[], conditions: [] as never[], enabled: true, ...over,
});
const state = (vars: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({ variables: vars as never, metadata });

describe("side AIs read lore the way the story AI does", () => {
  it("sends an every-turn entry", () => {
    expect(sendsEveryTurn(entry(), undefined, [], state({}))).toBe(true);
  });

  it("holds back an every-turn entry wired to variables until its conditions hold", () => {
    const secret = entry({ conditions: [{ variableId: "door", operator: "eq", value: true }], conditionLogic: "all" });
    expect(sendsEveryTurn(secret, undefined, [], state({ door: false }))).toBe(false);
    expect(sendsEveryTurn(secret, undefined, [], state({ door: true }))).toBe(true);
    expect(sendsEveryTurn(secret, undefined, [])).toBe(false);
  });

  it("holds back an entry bound to an interface slot until the slot is on", () => {
    const bindings = [{ slotId: "s", entryId: "e" }] as never[];
    expect(sendsEveryTurn(entry(), undefined, bindings, state({}))).toBe(false);
    expect(sendsEveryTurn(entry(), undefined, bindings, state({}, { activeLoreSlots: ["s"] }))).toBe(true);
  });
});
