import { describe, it, expect } from "vitest";
import { settlePoisonState, poisonPeriod, poisonPeriodAdvance, POISON_BAGS } from "../systems/poison-survival.js";
import { createMockGameState } from "./test-utils.js";
import { createEmptyRuleState } from "../rules/rule-state.js";

function state(variables = {}) {
  return createMockGameState({ variables: { health:100,hunger:100,"day-count":1,"player-name":"测试玩家","kill-log":[],"dead-names":"","user-kp":0,"npc-kp":"",...variables } });
}
/** A run this system has already settled once while the player was alive —
 *  the only state in which vitals are allowed to end it. */
function live(variables = {}) {
  const seen = settlePoisonState(state());
  return { ...seen, variables: { ...seen.variables, ...variables } };
}
describe("poison survival settlement", () => {
  it("deduplicates old aliases without awarding historical KP again", () => {
    const old=state({"dead-names":"沢村進，泽村进,権藤（教师）,陌生人", "npc-kp":"鳳惠介:5"});
    const next=settlePoisonState(old);
    expect(next.variables.survivors).toBe(39);
    expect(next.variables["npc-kp"]).toBe("鳳惠介:5");
    expect(settlePoisonState(next)).toEqual(next);
  });
  it("awards once and inherits a victim's points", () => {
    let next=settlePoisonState(state({"npc-kp":"沢村進:4"}));
    next.variables["kill-log"]=[{victim:"泽村进",killer:"鳳惠介",day:1},{victim:"沢村進",killer:"鳳惠介",day:1}];
    next=settlePoisonState(next);
    expect(next.variables["npc-kp"]).toContain("鳳惠介:5");
    expect(next.variables.survivors).toBe(39);
    expect(settlePoisonState(next)).toEqual(next);
  });
  it("keeps a confirmed death terminal after attempted healing", () => {
    let next=settlePoisonState(live({health:0}));
    next.variables.health=100;next.variables.hunger=100;
    next=settlePoisonState(next);
    expect(next.variables["game-status"]).toBe("dead");
    expect(next.variables.health).toBe(0);
    expect(next.variables.survivors).toBe(39);
  });
  it("ignores an obsolete death directive on a healthy legacy save", () => {
    const old=state();old.ruleState=createEmptyRuleState();old.ruleState.activeDirectives=[{id:"force_death",content:"dead",priority:1,persistent:true}];
    const next=settlePoisonState(old);
    expect(next.variables["game-status"]).toBe("active");
    expect(next.ruleState!.activeDirectives).toEqual([]);
  });
  it("ends starvation and awards shared victory only after seven full days", () => {
    expect(settlePoisonState(live({hunger:0})).variables["game-status"]).toBe("dead");
    expect(settlePoisonState(live({"day-count":7,"time-period":"夜晚"})).variables["game-status"]).toBe("active");
    expect(settlePoisonState(live({"day-count":8})).variables["game-status"]).toBe("won");
    expect(settlePoisonState(live({"day-count":8,health:0})).variables["game-status"]).toBe("dead");
  });
  it("initializes each bag atomically and refuses reinitializing an existing run", () => {
    for (const bag of Object.keys(POISON_BAGS)) {
      const next=settlePoisonState(state({"player-name":"","day-count":0,"player-setup":{name:"测试玩家",bag}}));
      expect(next.variables.inventory).toEqual(POISON_BAGS[bag]!.slice(1));
      expect(next.variables["day-count"]).toBe(1);
      expect(next.variables["user-weapon"]).toBe(POISON_BAGS[bag]![0]);
      next.variables.inventory=[];
      expect(settlePoisonState(next).variables.inventory).toEqual([]);
    }
  });
  it("restoring the pre-death snapshot restores the active run", () => {
    const before=settlePoisonState(state());
    const dead=settlePoisonState({...before,variables:{...before.variables,health:0}});
    expect(dead.variables["game-status"]).toBe("dead");
    expect(settlePoisonState(before).variables["game-status"]).toBe("active");
  });
  it("migrates simplified names and retains unrecognized death evidence", () => {
    const next=settlePoisonState(state({"dead-names":"三宅结衣,宫下芹奈,中岛遥,未知角色"}));
    expect(next.variables.survivors).toBe(37);
    expect(next.variables["unresolved-deaths"]).toEqual([{victim:"未知角色"}]);
    expect(settlePoisonState(next)).toEqual(next);
  });
  it("keeps legacy unnamed runs playable without restocking", () => {
    const old=state({"player-name":"",inventory:["旧物品"]});old.turnCount=5;
    const next=settlePoisonState(old);
    expect(next.variables["player-name"]).toBe("無名の生徒");
    expect(next.variables.inventory).toEqual(["旧物品"]);
  });
});

describe("poison survival — legacy saves this system never saw alive", () => {
  it("does not end a run that arrives already starving", () => {
    const old=state({hunger:0});old.turnCount=40;
    const next=settlePoisonState(old);
    expect(next.variables["game-status"]).toBe("active");
    expect(next.variables.health).toBe(100);
    // The reprieve survives every later reload, not just the first one.
    expect(settlePoisonState(next).variables["game-status"]).toBe("active");
  });
  it("re-arms the vitals rule once the grandfathered run recovers", () => {
    const old=state({hunger:0});old.turnCount=40;
    const fed=settlePoisonState(old);
    fed.variables.hunger=60;
    const recovered=settlePoisonState(fed);
    expect(recovered.variables["game-status"]).toBe("active");
    recovered.variables.hunger=0;
    expect(settlePoisonState(recovered).variables["game-status"]).toBe("dead");
  });
  it("still ends a legacy run whose own death was recorded in the log", () => {
    const old=state({"dead-names":"测试玩家",hunger:0});old.turnCount=40;
    expect(settlePoisonState(old).variables["game-status"]).toBe("dead");
  });
  it("rewrites a free-text clock onto the three-phase cycle", () => {
    expect(settlePoisonState(state({"time-period":"深夜"})).variables["time-period"]).toBe("夜晚");
    expect(settlePoisonState(state({"time-period":"傍晚"})).variables["time-period"]).toBe("下午");
    // Nothing recognisable in the value — leave it rather than guess.
    expect(settlePoisonState(state({"time-period":"推进"})).variables["time-period"]).toBe("推进");
  });
  it("resolves a death written with the surname the lorebook itself uses", () => {
    const next=settlePoisonState(state({"kill-log":[{victim:"馆林",killer:"佐野",day:1}]}));
    expect(next.variables["dead-names"]).toBe("館林颯太");
    expect(next.variables["unresolved-deaths"]).toEqual([]);
  });
  it("credits a surname kill on a run already under this system", () => {
    const next=settlePoisonState(live({"kill-log":[{victim:"馆林",killer:"佐野",day:1}]}));
    expect(next.variables["dead-names"]).toBe("館林颯太");
    expect(next.variables["npc-kp"]).toContain("佐野琉:1");
    expect(next.variables.survivors).toBe(39);
  });
  it("leaves a name that matches nobody, or more than one student, unresolved", () => {
    const next=settlePoisonState(state({"kill-log":[{victim:"木下翔",day:1}]}));
    expect(next.variables["dead-names"]).toBe("");
    expect(next.variables["unresolved-deaths"]).toEqual([{victim:"木下翔",day:1}]);
  });
});

describe("poison period canonicalisation", () => {
  it("reads the phase the writer meant", () => {
    expect(poisonPeriod("深夜")).toBe("夜晚");
    expect(poisonPeriod("黄昏")).toBe("下午");
    expect(poisonPeriod("清晨/最终对决")).toBe("上午");
    expect(poisonPeriod("Day 7 下午")).toBe("下午");
    expect(poisonPeriod("设置为白天")).toBe("上午");
    expect(poisonPeriod("最终夜")).toBe("夜晚");
    expect(poisonPeriod("推进")).toBeNull();
  });
  it("takes the target of an arrow, not its source", () => {
    expect(poisonPeriod("上午→下午")).toBe("下午");
    expect(poisonPeriod("下午 → 夜晚")).toBe("夜晚");
    expect(poisonPeriod("夜晚 → 深夜")).toBe("夜晚");
  });
  it("never reads 'afternoon' as the 'noon' inside it", () => {
    expect(poisonPeriod("afternoon")).toBe("下午");
    expect(poisonPeriod("Night")).toBe("夜晚");
    expect(poisonPeriod("midnight")).toBe("夜晚");
  });
  it("allows exactly one step forward and stores the canonical phase", () => {
    expect(poisonPeriodAdvance("深夜", "上午")).toBe("上午");
    expect(poisonPeriodAdvance("夜晚", "下午")).toBeNull();
    expect(poisonPeriodAdvance("上午", "上午")).toBeNull();
    expect(poisonPeriodAdvance("上午", "Day 2 下午")).toBe("下午");
  });
  it("lets a clock stuck on an unreadable value re-sync", () => {
    expect(poisonPeriodAdvance("推进", "夜晚")).toBe("夜晚");
    expect(poisonPeriodAdvance("推进", "毫无意义")).toBeNull();
  });
});
