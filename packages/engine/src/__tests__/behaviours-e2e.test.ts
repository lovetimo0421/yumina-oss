import { describe, it, expect } from "vitest";
import { GameStateManager } from "../state/game-state-manager.js";
import { ReactionEvaluator } from "../reactions/reaction-evaluator.js";
import { runReactionChain } from "../reactions/reaction-runner.js";
import {
  buildActionFiredEvent,
  buildMessageAIEvent,
  buildMessageUserEvent,
  buildSessionStartEvent,
  buildTurnCompleteEvent,
} from "../reactions/compile-rule.js";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import { LorebookMatcher } from "../lorebook/lorebook-matcher.js";
import type { Reaction, ReactionEffect, EventPattern } from "../events/types.js";
import type { Effect, WorldDefinition, WorldEntry, Variable } from "../types/index.js";
import { createMockEntry, createMockWorld } from "./test-utils.js";

// Every trigger and every effect the canvas offers, run the way the server
// runs a turn (routes/messages.ts send path; routes/sessions.ts /action for
// buttons and clock ticks): apply the AI's effects, emit the turn's events,
// run the reaction chain, then build the next prompt from the result.

const num = (id: string, defaultValue: number, extra: Partial<Variable> = {}): Variable =>
  ({ id, name: id, type: "number", defaultValue, min: 0, max: 1000, ...extra }) as Variable;
const reaction = (id: string, when: EventPattern, then: ReactionEffect[], extra: Partial<Reaction> = {}): Reaction => ({
  id, name: id, when, conditions: [], conditionLogic: "all", then, priority: 0, enabled: true, ...extra,
});
const setVar = (path: string, value: unknown, operation: string = "set"): ReactionEffect =>
  ({ type: "set", path, value, operation }) as ReactionEffect;
const notify = (message: string): ReactionEffect => ({ type: "emit", event: { type: "ui:notification", message, style: "info" } });

function makeWorld(reactions: Reaction[], extra: Partial<WorldDefinition> = {}): WorldDefinition {
  return createMockWorld({
    variables: [num("favor", 30), num("coins", 20), num("tipsy", 0), num("ticks", 0), num("n", 0), { id: "mood", name: "mood", type: "string", defaultValue: "calm" } as Variable, { id: "moments", name: "moments", type: "json", defaultValue: [] } as Variable],
    entries: [],
    reactions,
    rules: [],
    ...extra,
  } as Partial<WorldDefinition>);
}

/** One player turn, as the send path runs it. */
function turn(world: WorldDefinition, sm: GameStateManager, user: string, ai: string, aiEffects: Effect[] = []) {
  sm.incrementTurn();
  const changes = sm.applyEffects(aiEffects);
  const events = [buildMessageUserEvent(user), buildMessageAIEvent(ai), buildTurnCompleteEvent(sm.getSnapshot().turnCount)];
  if (sm.getSnapshot().turnCount === 1) events.push(buildSessionStartEvent());
  for (const c of changes) events.push({ type: "state:changed", variableId: c.variableId, oldValue: c.oldValue, newValue: c.newValue });
  const result = runReactionChain(new ReactionEvaluator(), sm, events, world.reactions ?? [], world.rules ?? [], { worldbooks: world.worldbooks });
  if (result.contextMessages.length > 0) sm.setMetadata("pendingContext", result.contextMessages);
  return result;
}
/** A button press or a clock tick, as /action runs it. */
function action(world: WorldDefinition, sm: GameStateManager, actionId: string, params?: Record<string, unknown>) {
  return runReactionChain(new ReactionEvaluator(), sm, [{ ...buildActionFiredEvent(actionId), ...(params ? { params } : {}) }], world.reactions ?? [], world.rules ?? [], { worldbooks: world.worldbooks });
}
function tick(world: WorldDefinition, sm: GameStateManager, seconds: number) {
  return runReactionChain(new ReactionEvaluator(), sm, [{ type: "clock:every", seconds }], world.reactions ?? [], world.rules ?? [], { worldbooks: world.worldbooks });
}
const v = (sm: GameStateManager, id: string) => sm.getSnapshot().variables[id];
const aiSays = (variableId: string, operation: Effect["operation"], value: unknown): Effect => ({ variableId, operation, value } as Effect);

describe("behaviours, end to end", () => {
  describe("triggers", () => {
    it("每回合 fires after every turn", () => {
      const w = makeWorld([reaction("r", { eventType: "turn:complete" }, [setVar("ticks", 1, "add")])]);
      const sm = new GameStateManager(w);
      turn(w, sm, "hi", "hello"); turn(w, sm, "hi", "hello");
      expect(v(sm, "ticks")).toBe(2);
    });

    it("每 N 回合 fires on every Nth turn only", () => {
      const w = makeWorld([reaction("r", { eventType: "turn:complete", match: { turnCount: { operator: "every", value: 3 } } }, [setVar("ticks", 1, "add")])]);
      const sm = new GameStateManager(w);
      for (let i = 0; i < 7; i++) turn(w, sm, "hi", "hello");
      expect(v(sm, "ticks")).toBe(2);
    });

    it("会话开始 fires on the first turn only", () => {
      const w = makeWorld([reaction("r", { eventType: "session:start" }, [setVar("ticks", 1, "add")])]);
      const sm = new GameStateManager(w);
      turn(w, sm, "hi", "hello"); turn(w, sm, "hi", "hello");
      expect(v(sm, "ticks")).toBe(1);
    });

    it("玩家说出关键词 / AI 说出关键词 match the message text", () => {
      const w = makeWorld([
        reaction("p", { eventType: "message:user", match: { content: { operator: "contains", value: "酒" } } }, [setVar("tipsy", 1, "add")]),
        reaction("a", { eventType: "message:ai", match: { content: { operator: "contains", value: "老鼠" } } }, [setVar("ticks", 1, "add")]),
      ]);
      const sm = new GameStateManager(w);
      turn(w, sm, "来一杯酒", "她倒了一杯。");
      turn(w, sm, "看看四周", "地窖里有一只老鼠。");
      expect(v(sm, "tipsy")).toBe(1);
      expect(v(sm, "ticks")).toBe(1);
    });

    it("变量变化 fires when the AI changes that variable", () => {
      const w = makeWorld([reaction("r", { eventType: "state:changed", match: { variableId: { operator: "eq", value: "favor" } } }, [setVar("ticks", 1, "add")])]);
      const sm = new GameStateManager(w);
      turn(w, sm, "hi", "hello");
      turn(w, sm, "夸她", "她笑了", [aiSays("favor", "add", 5)]);
      expect(v(sm, "ticks")).toBe(1);
    });

    it("变量越过阈值 fires on the crossing, in each direction, once", () => {
      const w = makeWorld([
        reaction("up", { eventType: "state:crossed", match: { variableId: { operator: "eq", value: "favor" }, direction: { operator: "eq", value: "rises-above" }, threshold: { operator: "eq", value: 80 } } }, [notify("up")]),
        reaction("down", { eventType: "state:crossed", match: { variableId: { operator: "eq", value: "favor" }, direction: { operator: "eq", value: "drops-below" }, threshold: { operator: "eq", value: 20 } } }, [notify("down")]),
      ]);
      const sm = new GameStateManager(w);
      expect(turn(w, sm, "a", "b", [aiSays("favor", "add", 40)]).notifications).toEqual([]);
      expect(turn(w, sm, "a", "b", [aiSays("favor", "add", 20)]).notifications.map((n) => n.message)).toEqual(["up"]);
      expect(turn(w, sm, "a", "b", [aiSays("favor", "add", 5)]).notifications).toEqual([]);
      expect(turn(w, sm, "a", "b", [aiSays("favor", "set", 10)]).notifications.map((n) => n.message)).toEqual(["down"]);
    });

    it("玩家点了某个按钮 fires on its action, with values passed in", () => {
      const w = makeWorld([reaction("buy", { eventType: "action:fired", match: { actionId: { operator: "contains", value: "buy-ale" } } }, [
        { type: "set", path: "coins", value: "{参数.价格}", operation: "subtract" } as ReactionEffect,
        setVar("tipsy", 1, "add"),
      ], { conditions: [{ variableId: "coins", operator: "gte", value: "{参数.价格}" } as never], elseMessage: "金币不够，要 {参数.价格}" })]);
      const sm = new GameStateManager(w);
      action(w, sm, "buy-ale", { 价格: 5 });
      expect(v(sm, "coins")).toBe(15);
      expect(v(sm, "tipsy")).toBe(1);
      const poor = action(w, sm, "buy-ale", { 价格: 50 });
      expect(v(sm, "coins")).toBe(15);
      expect(poor.notifications.map((n) => n.message)).toEqual(["金币不够，要 50"]);
      action(w, sm, "something-else");
      expect(v(sm, "tipsy")).toBe(1);
    });

    it("每隔几秒 fires on its clock tick only", () => {
      const w = makeWorld([reaction("r", { eventType: "clock:every", match: { seconds: { operator: "eq", value: 90 } } }, [setVar("ticks", 1, "add")])]);
      const sm = new GameStateManager(w);
      tick(w, sm, 90); tick(w, sm, 30); tick(w, sm, 90);
      expect(v(sm, "ticks")).toBe(2);
    });
  });

  describe("effects", () => {
    it("修改变量: set, add, subtract, multiply, toggle, append, and from another variable", () => {
      const w = makeWorld([reaction("r", { eventType: "session:start" }, [
        setVar("coins", 100, "set"), setVar("coins", 10, "add"), setVar("coins", 30, "subtract"), setVar("coins", 2, "multiply"),
        setVar("mood", "!", "append"),
        { type: "set", path: "n", value: 0, operation: "set", valueRef: "coins" } as ReactionEffect,
      ])], { variables: [num("coins", 0), num("n", 0), { id: "mood", name: "mood", type: "string", defaultValue: "calm" } as Variable, { id: "flag", name: "flag", type: "boolean", defaultValue: false } as Variable] } as Partial<WorldDefinition>);
      const sm = new GameStateManager(w);
      turn(w, sm, "hi", "hello");
      expect(v(sm, "coins")).toBe(160);
      expect(v(sm, "mood")).toBe("calm!");
      expect(v(sm, "n")).toBe(160);
      const w2 = makeWorld([reaction("t", { eventType: "turn:complete" }, [setVar("flag", true, "toggle")])], { variables: [{ id: "flag", name: "flag", type: "boolean", defaultValue: false } as Variable] } as Partial<WorldDefinition>);
      const sm2 = new GameStateManager(w2);
      turn(w2, sm2, "a", "b");
      expect(v(sm2, "flag")).toBe(true);
    });

    it("告诉 AI reaches the next turn's prompt once", () => {
      const w = makeWorld([reaction("r", { eventType: "session:start" }, [setVar("@prompt.context", "她今天心情很好。")])]);
      const sm = new GameStateManager(w);
      turn(w, sm, "hi", "hello");
      expect(sm.getSnapshot().metadata?.pendingContext).toEqual([{ message: "她今天心情很好。", role: "system" }]);
    });

    it("启用词条 / 禁用词条 switch what the AI reads — every-turn, standby and keyword entries alike", () => {
      const entries: WorldEntry[] = [
        createMockEntry({ id: "always", content: "ALWAYS LORE", alwaysSend: true, enabled: true }),
        createMockEntry({ id: "hidden-always", content: "HIDDEN EVERY-TURN", alwaysSend: true, enabled: false }),
        createMockEntry({ id: "standby", content: "STANDBY LORE", alwaysSend: false, enabled: false, keywords: [], conditions: [] }),
        createMockEntry({ id: "kw", content: "CELLAR LORE", alwaysSend: false, enabled: false, keywords: ["地窖"], conditions: [] }),
      ];
      const w = makeWorld([
        reaction("on", { eventType: "state:crossed", match: { variableId: { operator: "eq", value: "favor" }, direction: { operator: "eq", value: "rises-above" }, threshold: { operator: "eq", value: 79 } } }, [
          setVar("@prompt.entry.hidden-always", true), setVar("@prompt.entry.standby", true), setVar("@prompt.entry.kw", true), setVar("@prompt.entry.always", false),
        ]),
      ], { entries });
      const sm = new GameStateManager(w);
      const prompt = () => {
        const state = sm.getSnapshot();
        const toggled = state.ruleState?.toggledEntries ?? {};
        const matched = new LorebookMatcher().matchWithBudget(w.entries, ["我想去地窖"], state);
        const system = new PromptBuilder().buildSystemPrompt(w, state, undefined, undefined, undefined, toggled);
        const triggered = new PromptBuilder().buildTriggeredSystemMessages(w, state, matched.triggered, toggled).map((m) => m.content).join("\n");
        return system + "\n" + triggered;
      };
      turn(w, sm, "a", "b");
      let p = prompt();
      expect(p).toContain("ALWAYS LORE");
      expect(p).not.toContain("HIDDEN EVERY-TURN");
      expect(p).not.toContain("STANDBY LORE");
      expect(p).not.toContain("CELLAR LORE");
      turn(w, sm, "a", "b", [aiSays("favor", "set", 85)]);
      p = prompt();
      expect(p).not.toContain("ALWAYS LORE");
      expect(p).toContain("HIDDEN EVERY-TURN");
      expect(p).toContain("STANDBY LORE");
      expect(p).toContain("CELLAR LORE");
      expect(p.split("STANDBY LORE").length - 1).toBe(1);
    });

    it("启用/禁用变量 hides a variable from the AI and brings it back, keeping its value", () => {
      const w = makeWorld([
        reaction("hide", { eventType: "action:fired", match: { actionId: { operator: "contains", value: "hide" } } }, [setVar("@vars.enabled.coins", false)]),
        reaction("show", { eventType: "action:fired", match: { actionId: { operator: "contains", value: "show" } } }, [setVar("@vars.enabled.coins", true)]),
      ]);
      const sm = new GameStateManager(w);
      const block = () => new PromptBuilder().buildFormatBlock(w, sm.getSnapshot(), []);
      expect(block()).toContain("coins");
      action(w, sm, "hide");
      expect(block()).not.toContain("coins");
      expect(v(sm, "coins")).toBe(20);
      action(w, sm, "show");
      expect(block()).toContain("coins");
    });

    it("播放音乐 / 播放音效 / 停止音频 come out as audio effects", () => {
      const w = makeWorld([reaction("r", { eventType: "session:start" }, [setVar("@audio.bgm", "theme"), setVar("@audio.sfx", "bell"), setVar("@audio.stop", "theme")])]);
      const sm = new GameStateManager(w);
      const r = turn(w, sm, "hi", "hello");
      expect(r.audioEffects.length).toBe(3);
    });

    it("显示通知 reaches the player", () => {
      const w = makeWorld([reaction("r", { eventType: "session:start" }, [notify("欢迎光临")])]);
      expect(turn(w, new GameStateManager(w), "hi", "hello").notifications.map((n) => n.message)).toEqual(["欢迎光临"]);
    });

    it("解锁一个时刻 shows once, collected into its list", () => {
      const w = makeWorld([reaction("m", { eventType: "turn:complete" }, [{ type: "emit", event: { type: "ui:moment", title: "第一次干杯", message: "叮", collect: "moments" } }])]);
      const sm = new GameStateManager(w);
      const first = turn(w, sm, "a", "b");
      const second = turn(w, sm, "a", "b");
      expect(first.notifications.some((n) => n.title === "第一次干杯")).toBe(true);
      expect(second.notifications.some((n) => n.title === "第一次干杯")).toBe(false);
      expect(v(sm, "moments")).toEqual(["第一次干杯"]);
    });

    it("启用/禁用行为 switches another behaviour", () => {
      const w = makeWorld([
        reaction("counter", { eventType: "turn:complete" }, [setVar("ticks", 1, "add")]),
        reaction("off", { eventType: "action:fired", match: { actionId: { operator: "contains", value: "stop" } } }, [setVar("@rules.disabled.counter", true)]),
        reaction("on", { eventType: "action:fired", match: { actionId: { operator: "contains", value: "go" } } }, [setVar("@rules.disabled.counter", false)]),
      ]);
      const sm = new GameStateManager(w);
      turn(w, sm, "a", "b");
      action(w, sm, "stop");
      turn(w, sm, "a", "b");
      action(w, sm, "go");
      turn(w, sm, "a", "b");
      expect(v(sm, "ticks")).toBe(2);
    });
  });

  describe("options", () => {
    it("如果: all / any conditions gate the effect", () => {
      const w = makeWorld([
        reaction("all", { eventType: "turn:complete" }, [setVar("ticks", 1, "add")], { conditions: [{ variableId: "favor", operator: "gte", value: 30 }, { variableId: "coins", operator: "gte", value: 100 }] as never, conditionLogic: "all" }),
        reaction("any", { eventType: "turn:complete" }, [setVar("n", 1, "add")], { conditions: [{ variableId: "favor", operator: "gte", value: 30 }, { variableId: "coins", operator: "gte", value: 100 }] as never, conditionLogic: "any" }),
      ]);
      const sm = new GameStateManager(w);
      turn(w, sm, "a", "b");
      expect(v(sm, "ticks")).toBe(0);
      expect(v(sm, "n")).toBe(1);
    });

    it("停止条件 stops a behaviour once it holds", () => {
      const w = makeWorld([reaction("r", { eventType: "turn:complete" }, [setVar("ticks", 1, "add")], { stopConditions: [{ variableId: "ticks", operator: "gte", value: 2 }] as never })]);
      const sm = new GameStateManager(w);
      for (let i = 0; i < 5; i++) turn(w, sm, "a", "b");
      expect(v(sm, "ticks")).toBe(2);
    });

    it("冷却 and 最多触发几次", () => {
      const w = makeWorld([
        reaction("cool", { eventType: "turn:complete" }, [setVar("ticks", 1, "add")], { cooldownTurns: 2 }),
        reaction("max", { eventType: "turn:complete" }, [setVar("n", 1, "add")], { maxFireCount: 2 }),
      ]);
      const sm = new GameStateManager(w);
      for (let i = 0; i < 6; i++) turn(w, sm, "a", "b");
      expect(v(sm, "ticks")).toBeGreaterThanOrEqual(2);
      expect(v(sm, "ticks")).toBeLessThanOrEqual(3);
      expect(v(sm, "n")).toBe(2);
    });

    it("a behaviour's change sets off the next behaviour (chains)", () => {
      const w = makeWorld([
        reaction("first", { eventType: "session:start" }, [setVar("favor", 90)]),
        reaction("second", { eventType: "state:crossed", match: { variableId: { operator: "eq", value: "favor" }, direction: { operator: "eq", value: "rises-above" }, threshold: { operator: "eq", value: 80 } } }, [notify("chained")]),
      ]);
      const r = turn(w, new GameStateManager(w), "a", "b");
      expect(r.notifications.map((n) => n.message)).toEqual(["chained"]);
    });

    it("公式 recomputes after a behaviour changes its inputs", () => {
      const w = makeWorld([reaction("r", { eventType: "session:start" }, [setVar("coins", 100)])], {
        variables: [num("coins", 20), num("favor", 30), num("rating", 0, { formula: "round(favor / 10 + coins / 20)" } as Partial<Variable>)],
      } as Partial<WorldDefinition>);
      const sm = new GameStateManager(w);
      turn(w, sm, "a", "b");
      expect(v(sm, "rating")).toBe(8);
    });
  });
});
