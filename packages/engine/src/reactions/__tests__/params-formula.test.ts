import { describe, expect, it } from "vitest";
import { evaluateFormula } from "../../state/formula.js";
import { GameStateManager } from "../../state/game-state-manager.js";
import { ReactionEvaluator } from "../reaction-evaluator.js";
import type { Reaction } from "../../events/types.js";
import type { GameState, WorldDefinition } from "../../types/index.js";

const world = {
  id: "w",
  name: "商店",
  variables: [
    { id: "gold", name: "金币", type: "number", defaultValue: 50 },
    { id: "bag", name: "背包", type: "json", defaultValue: [] },
    { id: "base", name: "基础攻击", type: "number", defaultValue: 10 },
    { id: "lv", name: "等级", type: "number", defaultValue: 2 },
    { id: "atk", name: "攻击力", type: "number", defaultValue: 0, formula: "基础攻击 * (1 + 等级 * 0.1) + len(背包)" },
    { id: "dead", name: "dead-names", type: "string", defaultValue: "甲,乙" },
    { id: "alive", name: "存活", type: "number", defaultValue: 40, formula: "min(40, 40 - len({dead-names}))" },
  ],
  entries: [],
  settings: {},
} as unknown as WorldDefinition;

describe("formulas", () => {
  it("reads names, functions and braced names; refuses what it cannot read", () => {
    const vars: Record<string, unknown> = { 基础攻击: 10, 等级: 2, 背包: ["剑"], "dead-names": "甲,乙" };
    const look = (n: string) => vars[n];
    expect(evaluateFormula("基础攻击 × (1 + 等级 × 0.1) + len(背包)", look)).toBeCloseTo(13);
    expect(evaluateFormula("min(40, 40 - len({dead-names}))", look)).toBe(38);
    expect(evaluateFormula("if(等级 >= 2, 100, 0)", look)).toBe(100);
    expect(evaluateFormula("不存在 + 1", look)).toBeNull();
    expect(evaluateFormula("alert(1)", look)).toBeNull();
  });

  it("are worked out after every change, and on their own", () => {
    const m = new GameStateManager(world);
    const changes = m.applyEffects([{ variableId: "lv", operation: "add", value: 1 }]);
    expect(m.get("atk")).toBeCloseTo(13);
    expect(changes.map((c) => c.variableId)).toContain("atk");
    m.applyEffects([{ variableId: "dead", operation: "append", value: ",丙" }]);
    expect(m.get("alive")).toBe(37);
  });
});

describe("button parameters", () => {
  const buy: Reaction = {
    id: "buy", name: "购买", enabled: true, priority: 0,
    when: { eventType: "action:fired", match: { actionId: { operator: "eq", value: "购买" } } },
    conditions: [{ variableId: "gold", operator: "gte", value: "{参数.价格}" }],
    conditionLogic: "all",
    then: [
      { type: "set", path: "gold", operation: "subtract", value: "{参数.价格}" },
      { type: "set", path: "bag", operation: "push", value: "{参数.商品}" },
      { type: "emit", event: { type: "ui:notification", message: "买到了{参数.商品}", style: "success" } },
    ],
    elseMessage: "金币不够，{参数.商品}要 {参数.价格}",
  };
  const ev = new ReactionEvaluator();
  const state = { worldId: "w", variables: { gold: 50, bag: [] }, turnCount: 1, metadata: {} } as unknown as GameState;

  it("fill the behaviour, keep numbers numbers", () => {
    const r = ev.evaluate({ type: "action:fired", actionId: "购买", params: { 商品: "伞", 价格: "30" } }, [buy], [], state);
    expect(r.firedIds).toEqual(["buy"]);
    expect(r.legacyEffects).toEqual([
      { variableId: "gold", operation: "subtract", value: 30 },
      { variableId: "bag", operation: "push", value: "伞" },
    ]);
    expect(r.notifications).toEqual([{ message: "买到了伞", style: "success" }]);
  });

  it("say why when the condition fails", () => {
    const r = ev.evaluate({ type: "action:fired", actionId: "购买", params: { 商品: "金条", 价格: 80 } }, [buy], [], state);
    expect(r.firedIds).toEqual([]);
    expect(r.notifications).toEqual([{ message: "金币不够，金条要 80", style: "warning" }]);
  });
});

describe("moments", () => {
  it("unlock once: collected into the list, skipped once it is there", () => {
    const moment: Reaction = {
      id: "m", name: "初遇", enabled: true, priority: 0,
      when: { eventType: "turn:complete" }, conditions: [], conditionLogic: "all",
      then: [{ type: "emit", event: { type: "ui:moment", title: "初遇", message: "雨夜里第一次见到她", image: "https://x/y.png", collect: "cg" } }],
    };
    const ev = new ReactionEvaluator();
    const fresh = { worldId: "w", variables: { cg: [] }, turnCount: 1, metadata: {} } as unknown as GameState;
    const r = ev.evaluate({ type: "turn:complete" }, [moment], [], fresh);
    expect(r.notifications).toEqual([{ message: "雨夜里第一次见到她", style: "moment", title: "初遇", image: "https://x/y.png" }]);
    expect(r.legacyEffects).toEqual([{ variableId: "cg", operation: "push", value: "初遇" }]);
    const again = ev.evaluate({ type: "turn:complete" }, [moment], [], { ...fresh, variables: { cg: ["初遇"] } } as GameState);
    expect(again.notifications).toEqual([]);
    expect(again.legacyEffects).toEqual([]);
  });
});

describe("the chain runner passes notices through", () => {
  it("a failed purchase says why; a moment shows its card", async () => {
    const { runReactionChain } = await import("../reaction-runner.js");
    const shop = {
      ...world,
      reactions: [] as Reaction[],
    } as unknown as WorldDefinition;
    const buy: Reaction = {
      id: "buy", name: "购买", enabled: true, priority: 0,
      when: { eventType: "action:fired", match: { actionId: { operator: "eq", value: "购买" } } },
      conditions: [{ variableId: "gold", operator: "gte", value: "{参数.价格}" }], conditionLogic: "all",
      then: [{ type: "set", path: "gold", operation: "subtract", value: "{参数.价格}" }],
      elseMessage: "金币不够，要 {参数.价格}",
    };
    const m = new GameStateManager(shop);
    const r = runReactionChain(new ReactionEvaluator(), m, [{ type: "action:fired", actionId: "购买", params: { 价格: 80 } }], [buy], []);
    expect(r.notifications).toEqual([{ message: "金币不够，要 80", style: "warning" }]);
    const moment: Reaction = {
      id: "m", name: "初遇", enabled: true, priority: 0, when: { eventType: "turn:complete" }, conditions: [], conditionLogic: "all",
      then: [{ type: "emit", event: { type: "ui:moment", title: "初遇", message: "雨夜", collect: "bag" } }],
    };
    const r2 = runReactionChain(new ReactionEvaluator(), m, [{ type: "turn:complete" }], [moment], []);
    expect(r2.notifications).toEqual([{ message: "雨夜", style: "moment", title: "初遇" }]);
    expect(m.get("bag")).toEqual(["初遇"]);
  });
});
