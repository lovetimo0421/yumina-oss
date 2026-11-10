import { describe, it, expect } from "vitest";
import { GameStateManager } from "../state/game-state-manager.js";
import { ReactionEvaluator } from "../reactions/reaction-evaluator.js";
import { runReactionChain } from "../reactions/reaction-runner.js";
import { buildTurnCompleteEvent } from "../reactions/compile-rule.js";
import { computeActiveWorldbookIds } from "../lorebook/worldbook.js";
import { matchWorldbookSwitches, applyWorldbookSwitches } from "../lorebook/worldbook-switch.js";
import { replyRoom } from "../lorebook/station.js";
import { applyReplyRules } from "../parser/reply-rules.js";
import { remapReactionReferences } from "../reactions/remap.js";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import type { Reaction } from "../events/types.js";
import type { GameState, Variable, WorldDefinition, Worldbook } from "../types/index.js";
import { createMockEntry, createMockWorld } from "./test-utils.js";

// Scenarios (情境), where AIs live, and reply rules (回复处理), checked against
// what the creator docs promise.

const wb = (id: string, activation: Worldbook["activation"], extra: Partial<Worldbook> = {}): Worldbook =>
  ({ id, name: id, order: 0, activation, ...extra }) as Worldbook;

/** The player speaks: keyword scenarios latch the way the send path does it. */
function say(state: GameState, books: Worldbook[], text: string): GameState {
  const res = matchWorldbookSwitches(books, text, state.ruleState?.toggledWorldbooks ?? {});
  return { ...state, ruleState: { ...(state.ruleState ?? {}), toggledWorldbooks: applyWorldbookSwitches(state.ruleState?.toggledWorldbooks, res) } } as GameState;
}

describe("scenarios", () => {
  const cellar = wb("cellar", { mode: "keywords", keywords: ["地窖"], leaveKeywords: ["回酒馆"] } as never);
  const tower = wb("tower", { mode: "keywords", keywords: ["塔"] } as never);

  it("玩家说到某些词: the player walks in, stays in, and leaves on a leave word", () => {
    const books = [cellar];
    let s = new GameStateManager(createMockWorld({ worldbooks: books } as Partial<WorldDefinition>)).getSnapshot();
    expect(computeActiveWorldbookIds(books, s).has("cellar")).toBe(false);
    s = say(s, books, "我想去地窖看看");
    expect(computeActiveWorldbookIds(books, s).has("cellar")).toBe(true);
    s = say(s, books, "继续往下走");
    expect(computeActiveWorldbookIds(books, s).has("cellar")).toBe(true);
    s = say(s, books, "算了，回酒馆吧");
    expect(computeActiveWorldbookIds(books, s).has("cellar")).toBe(false);
  });

  it("打开时关掉其它: closes the other exclusive keyword scenarios only", () => {
    const a = wb("a", { mode: "keywords", keywords: ["矿坑"], exclusive: true } as never);
    const b = wb("b", { mode: "keywords", keywords: ["雪原"], exclusive: true } as never);
    const books = [a, b, tower];
    let s = new GameStateManager(createMockWorld({ worldbooks: books } as Partial<WorldDefinition>)).getSnapshot();
    s = say(s, books, "去矿坑"); s = say(s, books, "上塔");
    s = say(s, books, "去雪原");
    const on = computeActiveWorldbookIds(books, s);
    expect([on.has("a"), on.has("b"), on.has("tower")]).toEqual([false, true, true]);
  });

  it("变量满足条件时 and 从某个开场进来时", () => {
    const where = wb("mine", { mode: "conditions", conditions: [{ variableId: "loc", operator: "eq", value: "矿坑" }], conditionLogic: "all" } as never);
    const opening = wb("routeB", { mode: "greeting", greetingIds: ["g-b"] } as never);
    const books = [where, opening];
    const world = createMockWorld({ worldbooks: books, variables: [{ id: "loc", name: "loc", type: "string", defaultValue: "镇上" } as Variable] } as Partial<WorldDefinition>);
    const sm = new GameStateManager(world);
    expect(computeActiveWorldbookIds(books, sm.getSnapshot()).size).toBe(0);
    sm.applyEffects([{ variableId: "loc", operation: "set", value: "矿坑" } as never]);
    expect(computeActiveWorldbookIds(books, sm.getSnapshot()).has("mine")).toBe(true);
    const fromB = { ...sm.getSnapshot(), activeGreetingId: "g-b" } as GameState;
    expect(computeActiveWorldbookIds(books, fromB).has("routeB")).toBe(true);
    const fromA = { ...sm.getSnapshot(), activeGreetingId: "g-a" } as GameState;
    expect(computeActiveWorldbookIds(books, fromA).has("routeB")).toBe(false);
  });

  it("a scenario's entries reach the AI only while it is on; the card's always do", () => {
    const books = [cellar];
    const world = createMockWorld({
      worldbooks: books,
      entries: [
        createMockEntry({ id: "card", content: "CARD LORE", alwaysSend: true }),
        createMockEntry({ id: "inside", content: "CELLAR LORE", alwaysSend: true, worldbookId: "cellar" } as never),
      ],
    } as Partial<WorldDefinition>);
    let s = new GameStateManager(world).getSnapshot();
    const prompt = () => new PromptBuilder().buildSystemPrompt(world, s);
    expect(prompt()).toContain("CARD LORE");
    expect(prompt()).not.toContain("CELLAR LORE");
    s = say(s, books, "下地窖");
    expect(prompt()).toContain("CELLAR LORE");
  });

  it("a scenario's behaviours run only while it is on", () => {
    const books = [cellar];
    const r: Reaction = { id: "torch", name: "torch", when: { eventType: "turn:complete" }, conditions: [], conditionLogic: "all", then: [{ type: "set", path: "n", value: 1, operation: "add" } as never], priority: 0, enabled: true, worldbookId: "cellar" };
    const world = createMockWorld({ worldbooks: books, reactions: [r], rules: [], variables: [{ id: "n", name: "n", type: "number", defaultValue: 0 } as Variable] } as Partial<WorldDefinition>);
    const sm = new GameStateManager(world);
    const run = () => runReactionChain(new ReactionEvaluator(), sm, [buildTurnCompleteEvent(1)], [r], [], { worldbooks: books });
    run();
    expect(sm.getSnapshot().variables.n).toBe(0);
    const inside = say(sm.getSnapshot(), books, "去地窖");
    const sm2 = new GameStateManager(world, inside);
    runReactionChain(new ReactionEvaluator(), sm2, [buildTurnCompleteEvent(2)], [r], [], { worldbooks: books });
    expect(sm2.getSnapshot().variables.n).toBe(1);
  });
});

describe("启用/禁用情境", () => {
  const sw = (id: string, path: string, value: boolean): Reaction => ({ id, name: id, when: { eventType: "action:fired", match: { actionId: { operator: "contains", value: id } } }, conditions: [], conditionLogic: "all", then: [{ type: "set", path, value, operation: "set" } as never], priority: 0, enabled: true });
  const fire = (sm: GameStateManager, reactions: Reaction[], books: Worldbook[], id: string) =>
    runReactionChain(new ReactionEvaluator(), sm, [{ type: "action:fired", actionId: id }], reactions, [], { worldbooks: books });

  it("a behaviour switches a 只看启用开关 scenario off and back on", () => {
    const night = wb("night", { mode: "manual" } as never);
    const books = [night];
    const reactions = [sw("close", "@worldbooks.on.night", false), sw("open", "@worldbooks.on.night", true)];
    const sm = new GameStateManager(createMockWorld({ worldbooks: books, reactions } as Partial<WorldDefinition>));
    expect(computeActiveWorldbookIds(books, sm.getSnapshot()).has("night")).toBe(true);
    fire(sm, reactions, books, "close");
    expect(computeActiveWorldbookIds(books, sm.getSnapshot()).has("night")).toBe(false);
    fire(sm, reactions, books, "open");
    expect(computeActiveWorldbookIds(books, sm.getSnapshot()).has("night")).toBe(true);
  });

  it("a behaviour can open or close a keyword scenario too; conditions and openings stay in charge of theirs", () => {
    const cellar = wb("cellar", { mode: "keywords", keywords: ["地窖"] } as never);
    const mine = wb("mine", { mode: "conditions", conditions: [{ variableId: "loc", operator: "eq", value: "矿坑" }], conditionLogic: "all" } as never);
    const books = [cellar, mine];
    const reactions = [sw("in", "@worldbooks.on.cellar", true), sw("forcemine", "@worldbooks.on.mine", true)];
    const world = createMockWorld({ worldbooks: books, reactions, variables: [{ id: "loc", name: "loc", type: "string", defaultValue: "镇上" } as Variable] } as Partial<WorldDefinition>);
    const sm = new GameStateManager(world);
    fire(sm, reactions, books, "in");
    fire(sm, reactions, books, "forcemine");
    const on = computeActiveWorldbookIds(books, sm.getSnapshot());
    expect([on.has("cellar"), on.has("mine")]).toEqual([true, false]);
  });

  it("installing a bundle remaps the scenario and variable a switch names", () => {
    const r = { ...sw("x", "@worldbooks.on.old-wb", true), then: [{ type: "set", path: "@worldbooks.on.old-wb", value: true, operation: "set" }, { type: "set", path: "@vars.enabled.old-var", value: false, operation: "set" }] } as Reaction;
    const out = remapReactionReferences(r, { variableId: (id) => (id === "old-var" ? "new-var" : id), entryId: (id) => id, reactionId: (id) => id, worldbookId: (id) => (id === "old-wb" ? "new-wb" : id) });
    expect(out.then.map((e) => (e as { path: string }).path)).toEqual(["@worldbooks.on.new-wb", "@vars.enabled.new-var"]);
  });
});

describe("where AIs live", () => {
  const cellar = wb("cellar", { mode: "keywords", keywords: ["地窖"] } as never);
  const rat = wb("rat", { mode: "always" } as never, { host: "cellar", station: { kind: "narrator" } } as never);
  const bard = wb("bard", { mode: "always" } as never, { host: "card", station: { kind: "narrator" } } as never);

  it("on the card the narrator answers first, then the AIs living on the card", () => {
    const books = [cellar, rat, bard];
    const s = new GameStateManager(createMockWorld({ worldbooks: books } as Partial<WorldDefinition>)).getSnapshot();
    const room = replyRoom(books, computeActiveWorldbookIds(books, s));
    expect(room.members.map((m) => m?.id ?? "narrator")).toEqual(["narrator", "bard"]);
  });

  it("in a scenario its own AI answers instead of the narrator, unless the narrator stays", () => {
    const books = [cellar, rat];
    let s = new GameStateManager(createMockWorld({ worldbooks: books } as Partial<WorldDefinition>)).getSnapshot();
    s = say(s, books, "下地窖");
    expect(replyRoom(books, computeActiveWorldbookIds(books, s)).members.map((m) => m?.id ?? "narrator")).toEqual(["rat"]);
    const stays = [{ ...cellar, narratorHere: true } as Worldbook, rat];
    expect(replyRoom(stays, computeActiveWorldbookIds(stays, s)).members.map((m) => m?.id ?? "narrator")).toEqual(["narrator", "rat"]);
  });

  it("an AI not placed anywhere is never in play", () => {
    const loose = wb("loose", { mode: "always" } as never, { host: "unplaced", station: { kind: "narrator" } } as never);
    const books = [loose];
    const s = new GameStateManager(createMockWorld({ worldbooks: books } as Partial<WorldDefinition>)).getSnapshot();
    expect(computeActiveWorldbookIds(books, s).has("loose")).toBe(false);
  });
});

describe("回复处理", () => {
  const vars = [{ id: "favor", name: "好感", type: "number", defaultValue: 30 }, { id: "time", name: "时段", type: "string", defaultValue: "傍晚" }] as Variable[];

  it("a tagged block in any of the three spellings is hidden and its fields written by name", () => {
    for (const block of ["<状态>好感: 45\n时段: 深夜</状态>", "【状态】好感: 45\n时段: 深夜【/状态】", "[状态]好感: 45\n时段: 深夜[/状态]"]) {
      const out = applyReplyRules({ variables: vars, replyRules: [{ id: "s", match: { tag: "状态" }, hide: true, to: [{ kind: "fields" }] }] } as never, `她转身走了。\n${block}`);
      expect(out.text.trim()).toBe("她转身走了。");
      const byVar = Object.fromEntries(out.effects.map((e) => [e.variableId, e.value]));
      expect(byVar).toEqual({ favor: 45, time: "深夜" });
    }
  });

  it("routes to an event and an interface channel, and a pattern rule takes its first group", () => {
    const out = applyReplyRules({ variables: vars, replyRules: [
      { id: "end", match: { tag: "结局" }, hide: true, to: [{ kind: "event", name: "ending" }] },
      { id: "sms", match: { pattern: "📱(.+)" }, hide: true, to: [{ kind: "channel", channel: "phone" }] },
    ] } as never, "故事结束了。\n<结局>好结局</结局>\n📱明天见");
    expect(out.events).toContain("ending");
    expect(out.channels.map((c) => [c.channel, c.text.trim()])).toEqual([["phone", "明天见"]]);
    expect(out.text.trim()).toBe("故事结束了。");
  });
});
