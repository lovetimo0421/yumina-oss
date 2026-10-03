import { describe, it, expect } from "vitest";
import { buildContinuityPlan, applyContinuityPlan, CONTINUITY_THRESHOLDS, CONTINUITY_KEEP, CONTINUITY_NONE, CONTINUITY_PLAYLIST } from "./index.js";
import { filterAiEffects, isContinuityEligible, isContinuityOwned } from "../state/variable-activation.js";
import type { GameState, WorldDefinition } from "../types/index.js";

function world(over: Partial<WorldDefinition> = {}): WorldDefinition {
  return {
    id: "w", version: "1", name: "w", description: "", author: "", language: "zh",
    entries: [], rules: [], components: [], customUI: [],
    variables: [
      { id: "hp", name: "生命值", type: "number", defaultValue: 100, min: 0, max: 100, precise: true, deltaDown: 35, deltaUp: 30, behaviorRules: "被砍掉 5 到 15" },
      { id: "fav", name: "好感", type: "number", defaultValue: 50, min: 0, max: 100, precise: true, deltaDown: 0, deltaUp: 5 },
      { id: "wanted", name: "被通缉", type: "boolean", defaultValue: false, precise: true },
      { id: "loc", name: "位置", type: "string", defaultValue: "大堂", precise: true, options: ["大堂", "后山", "客房"] },
      { id: "name", name: "名字", type: "string", defaultValue: "", precise: true },
      { id: "gold", name: "金钱", type: "number", defaultValue: 300, precise: true, deltaDown: 5000, deltaUp: 5000 },
      { id: "bag", name: "背包", type: "json", defaultValue: [], precise: true },
    ],
    audioTracks: [
      { id: "t1", name: "庙会", type: "bgm", url: "u", aiNote: "热闹" },
      { id: "t2", name: "灵堂", type: "bgm", url: "u", aiNote: "有人死了" },
      { id: "t3", name: "无注释", type: "bgm", url: "u" },
      { id: "s1", name: "刀剑", type: "sfx", url: "u", aiNote: "拔刀" },
    ],
    sceneImages: [
      { id: "img1", name: "大堂夜", url: "u", scene: "夜里在大堂" },
      { id: "img2", name: "破庙", url: "u", scene: "到了后山破庙" },
    ],
    continuity: { bgm: true, sfx: true, images: true },
    ...over,
  } as WorldDefinition;
}

function state(vars: Record<string, unknown> = {}, extra: Partial<GameState> = {}): GameState {
  return { worldId: "w", variables: { hp: 100, fav: 50, wanted: false, loc: "大堂", name: "", gold: 300, ...vars } as GameState["variables"], turnCount: 5, metadata: {}, ...extra };
}

const input = (over = {}) => ({ playerText: "我拔刀", replyText: "刀光一闪。", turnCount: 5, memory: {}, hasImageDirective: false, hasAudioDirective: false, ...over });

describe("eligibility", () => {
  it("numbers need a window that fits 255 options; strings need options; json never", () => {
    const w = world();
    const byId = Object.fromEntries(w.variables.map((v) => [v.id, v]));
    expect(isContinuityEligible(byId.hp!)).toBe(true);
    expect(isContinuityEligible(byId.fav!)).toBe(true);
    expect(isContinuityEligible(byId.gold!)).toBe(false); // 10001 options
    expect(isContinuityEligible(byId.name!)).toBe(false); // no options
    expect(isContinuityEligible(byId.loc!)).toBe(true);
    expect(isContinuityEligible(byId.wanted!)).toBe(true);
    expect(isContinuityEligible(byId.bag!)).toBe(false);
    expect(isContinuityOwned(w, byId.hp!)).toBe(true);
    expect(isContinuityOwned({ continuity: { enabled: false } }, byId.hp!)).toBe(false);
  });

  it("drops the narrative model's directives for owned variables, keeps the rest", () => {
    const w = world();
    const r = filterAiEffects(w, state(), [
      { variableId: "hp", operation: "subtract", value: 10 },
      { variableId: "gold", operation: "subtract", value: 300 },
      { variableId: "name", operation: "set", value: "阿明" },
    ]);
    expect(r.dropped.map((e) => e.variableId)).toEqual(["hp"]);
    expect(r.kept.map((e) => e.variableId)).toEqual(["gold", "name"]);
  });
});

describe("plan", () => {
  it("offers every integer delta inside the window and the bounds, plus pools", () => {
    const plan = buildContinuityPlan(world(), state({ hp: 20, fav: 98 }), input())!;
    expect(plan).not.toBeNull();
    const hp = plan.questions["var__hp"]!;
    expect(hp.type).toBe("choice");
    const hpLabels = Object.keys((hp as { criteria: Record<string, string> }).criteria);
    expect(hpLabels).toContain("-20");
    expect(hpLabels).not.toContain("-21"); // would go below min 0
    expect(hpLabels).toContain("+30");
    expect(hpLabels).toContain("0");
    const fav = plan.questions["var__fav"] as { criteria: Record<string, string> };
    expect(Object.keys(fav.criteria).sort()).toEqual(["+1", "+2", "0"]); // capped at max 100
    expect(plan.questions["var__wanted"]!.type).toBe("noul");
    const loc = plan.questions["var__loc"] as { criteria: Record<string, string> };
    expect(Object.keys(loc.criteria)).toEqual(["大堂", "后山", "客房", CONTINUITY_KEEP]);
    expect(plan.questions["var__name"]).toBeUndefined();
    expect(plan.questions["var__gold"]).toBeUndefined();
    const bgm = plan.questions["bgm"] as { criteria: Record<string, string> };
    expect(Object.keys(bgm.criteria)).toEqual(["t1", "t2", CONTINUITY_KEEP]); // t3 has no note
    expect(plan.questions["sfx__s1"]!.type).toBe("noul");
    expect(plan.questions["image__img1"]!.type).toBe("noul");
    expect(plan.questions["image__img1"]!.instructions).toContain("夜里在大堂");
    expect(plan.questions["image__img2"]!.type).toBe("noul");
    expect(plan.state.variables).toEqual({ 生命值: 20, 好感: 98, 被通缉: false, 位置: "大堂" });
  });

  it("skips pools when the reply already carries its own directives, and returns null with nothing to ask", () => {
    const plan = buildContinuityPlan(world(), state(), input({ hasAudioDirective: true, hasImageDirective: true }))!;
    expect(plan.questions["bgm"]).toBeUndefined();
    expect(plan.questions["sfx__s1"]).toBeUndefined();
    expect(plan.questions["image__img1"]).toBeUndefined();
    // Cued tracks and images are in the pool without any switch; opting out
    // and having no cues both leave nothing to ask.
    const optedOut = buildContinuityPlan(world({ variables: [], continuity: { bgm: false, sfx: false, images: false } }), state(), input());
    expect(optedOut).toBeNull();
    const noCues = buildContinuityPlan(world({ variables: [], continuity: {}, audioTracks: [{ id: "t3", name: "无注释", type: "bgm", url: "u" }], sceneImages: [{ id: "i9", name: "无说明", url: "u", scene: " " }] }), state(), input());
    expect(noCues).toBeNull();
    const cuedOnly = buildContinuityPlan(world({ variables: [], continuity: {} }), state(), input())!;
    expect(Object.keys(cuedOnly.questions)).toEqual(["bgm", "sfx__s1", "image__img1", "image__img2"]);
    expect(buildContinuityPlan(world({ continuity: { enabled: false } }), state(), input())).toBeNull();
  });

  it("a number pinned at its bound with no room is not asked", () => {
    const plan = buildContinuityPlan(world(), state({ fav: 100 }), input())!;
    expect(plan.questions["var__fav"]).toBeUndefined();
  });
});

describe("apply", () => {
  const plan = () => buildContinuityPlan(world(), state({ hp: 80 }), input())!;

  it("takes the probability-weighted mean for numbers and needs direction mass ≥ 0.8", () => {
    const r = applyContinuityPlan(plan(), {
      var__hp: { type: "choice", probabilities: { "-8": 0.2, "-10": 0.5, "-12": 0.25, "0": 0.05 } },
    }, 5, {});
    const eff = r.effects.find((e) => e.variableId === "hp");
    expect(eff).toEqual({ variableId: "hp", operation: "set", value: 70 }); // 80 − 10.05 → 70
    expect(r.decisions.find((d) => d.key === "var__hp")!.applied).toBe(true);
  });

  it("stays put when the mass is split or the weighted delta rounds to 0", () => {
    const split = applyContinuityPlan(plan(), { var__hp: { type: "choice", probabilities: { "-5": 0.5, "+5": 0.5 } } }, 5, {});
    expect(split.effects.find((e) => e.variableId === "hp")).toBeUndefined();
    const weak = applyContinuityPlan(plan(), { var__hp: { type: "choice", probabilities: { "0": 0.7, "-1": 0.3 } } }, 5, {});
    expect(weak.effects.find((e) => e.variableId === "hp")).toBeUndefined();
  });

  it("clamps to min/max and ignores labels outside the window", () => {
    const r = applyContinuityPlan(plan(), { var__hp: { type: "choice", probabilities: { "-35": 1, "-999": 1 } } }, 5, {});
    expect(r.effects.find((e) => e.variableId === "hp")!.value).toBe(45);
  });

  it("booleans flip only past the threshold, strings only with confidence and a listed value", () => {
    const r = applyContinuityPlan(plan(), {
      var__wanted: { type: "noul", noul: 0.92 },
      var__loc: { type: "choice", choice: "后山", probabilities: { 后山: 0.9, [CONTINUITY_KEEP]: 0.1 }, confidence: 0.9 },
    }, 5, {});
    expect(r.effects).toContainEqual({ variableId: "wanted", operation: "set", value: true });
    expect(r.effects).toContainEqual({ variableId: "loc", operation: "set", value: "后山" });
    const meh = applyContinuityPlan(plan(), {
      var__wanted: { type: "noul", noul: 0.6 },
      var__loc: { type: "choice", choice: "火星", probabilities: { 火星: 0.99 }, confidence: 0.99 },
    }, 5, {});
    expect(meh.effects).toEqual([]);
  });

  it("switches BGM only with a margin over keep and after the cooldown; remembers the switch", () => {
    const first = applyContinuityPlan(plan(), { bgm: { type: "choice", choice: "t2", probabilities: { t2: 0.7, t1: 0.1, [CONTINUITY_KEEP]: 0.2 } } }, 5, {});
    expect(first.audioEffects).toEqual([{ trackId: "t2", action: "crossfade", fadeDuration: CONTINUITY_THRESHOLDS.bgmFadeSeconds, source: "continuity" }]);
    expect(first.memory.lastBgmTurn).toBe(5);
    const tooSoon = applyContinuityPlan(plan(), { bgm: { type: "choice", choice: "t1", probabilities: { t1: 0.9 } } }, 6, first.memory);
    expect(tooSoon.audioEffects).toEqual([]);
    expect(tooSoon.decisions.find((d) => d.kind === "bgm")!.reason).toBe("cooldown");
    const noMargin = applyContinuityPlan(plan(), { bgm: { type: "choice", choice: "t1", probabilities: { t1: 0.5, [CONTINUITY_KEEP]: 0.45 } } }, 9, first.memory);
    expect(noMargin.audioEffects).toEqual([]);
  });

  it("offers a playlist hand-back only while its own pick is sounding, and stops that track when chosen", () => {
    const withPlaylist = (vars: Record<string, unknown>, extra: Partial<GameState> = {}) =>
      buildContinuityPlan(world({ bgmPlaylist: { tracks: ["t3"], playMode: "loop", autoPlay: true, waitForFirstMessage: false, gapSeconds: 0 } }), state(vars, extra), input())!;
    // Nothing of the judge's is playing: no hand-back option.
    const idle = withPlaylist({});
    expect(Object.keys((idle.questions["bgm"] as { criteria: Record<string, string> }).criteria)).not.toContain(CONTINUITY_PLAYLIST);
    // Its own pick is the active BGM (resume snapshot says so): option appears.
    const sounding = withPlaylist({}, { metadata: { activeAudio: [{ trackId: "t2", action: "play" }] } });
    expect(Object.keys((sounding.questions["bgm"] as { criteria: Record<string, string> }).criteria)).toContain(CONTINUITY_PLAYLIST);
    const r = applyContinuityPlan(sounding, { bgm: { type: "choice", choice: CONTINUITY_PLAYLIST, probabilities: { [CONTINUITY_PLAYLIST]: 0.8, [CONTINUITY_KEEP]: 0.1 } } }, 9, {});
    expect(r.audioEffects).toEqual([{ trackId: "t2", action: "stop", fadeDuration: CONTINUITY_THRESHOLDS.bgmFadeSeconds, source: "continuity" }]);
    expect(r.memory.lastBgmTrack).toBeUndefined();
  });

  it("carries the author's music choices on the effects: AI over rules, play once, no ducking", () => {
    const chosen = buildContinuityPlan(world({ continuity: { music: { overRules: true, once: true, duck: false } } }), state(), input())!;
    const r = applyContinuityPlan(chosen, {
      bgm: { type: "choice", choice: "t2", probabilities: { t2: 0.8, [CONTINUITY_KEEP]: 0.1 } },
      sfx__s1: { type: "noul", noul: 0.95 },
    }, 5, {});
    expect(r.audioEffects).toEqual([
      { trackId: "t2", action: "crossfade", fadeDuration: CONTINUITY_THRESHOLDS.bgmFadeSeconds, source: "continuity", overRules: true, loop: false },
      { trackId: "s1", action: "play", source: "continuity", duckBgm: false },
    ]);
    // Defaults: rules first, loop until switched, duck the music.
    const dflt = applyContinuityPlan(plan(), { bgm: { type: "choice", choice: "t2", probabilities: { t2: 0.8 } }, sfx__s1: { type: "noul", noul: 0.95 } }, 5, {});
    expect(dflt.audioEffects[0]).not.toHaveProperty("overRules");
    expect(dflt.audioEffects[0]).not.toHaveProperty("loop");
    expect(dflt.audioEffects[1]).toMatchObject({ duckBgm: true });
  });

  it("fires an SFX once past 0.9 and not again within the cooldown", () => {
    const a = applyContinuityPlan(plan(), { sfx__s1: { type: "noul", noul: 0.95 } }, 5, {});
    expect(a.audioEffects).toEqual([{ trackId: "s1", action: "play", source: "continuity", duckBgm: true }]);
    const b = applyContinuityPlan(plan(), { sfx__s1: { type: "noul", noul: 0.95 } }, 6, a.memory);
    expect(b.audioEffects).toEqual([]);
    const c = applyContinuityPlan(plan(), { sfx__s1: { type: "noul", noul: 0.95 } }, 8, a.memory);
    expect(c.audioEffects.length).toBe(1);
  });

  it("sends an image whenever its author condition is met — again and again, no cooldown", () => {
    const yes = { image__img1: { type: "noul" as const, noul: 0.95 } };
    let memory = {};
    for (let turn = 5; turn <= 9; turn++) {
      const r = applyContinuityPlan(plan(), yes, turn, memory);
      expect(r.imageIds).toEqual(["img1"]);
      memory = r.memory;
    }
  });

  it("sends nothing when no condition is met, and every image whose condition is met", () => {
    const none = applyContinuityPlan(plan(), { image__img1: { type: "noul", noul: 0.1 }, image__img2: { type: "noul", noul: 0.3 } }, 5, {});
    expect(none.imageIds).toEqual([]);
    expect(none.decisions.filter((d) => d.kind === "image").map((d) => d.reason)).toEqual(["condition-not-met", "condition-not-met"]);
    const both = applyContinuityPlan(plan(), { image__img1: { type: "noul", noul: 0.9 }, image__img2: { type: "noul", noul: 0.8 } }, 6, none.memory);
    expect(both.imageIds).toEqual(["img1", "img2"]);
    const borderline = applyContinuityPlan(plan(), { image__img1: { type: "noul", noul: 0.6 } }, 7, {});
    expect(borderline.imageIds).toEqual([]);
  });

  it("asks one question per image carrying the author's condition as the rule", () => {
    const p = buildContinuityPlan(world({ variables: [], sceneImages: [{ id: "cup", name: "咖啡", url: "u", scene: "任何情况下，每次回复后，发送这个图片" }] }), state(), input())!;
    const q = p.questions["image__cup"]!;
    expect(q.type).toBe("noul");
    expect(q.instructions).toContain("任何情况下，每次回复后，发送这个图片");
    expect(p.meta.images).toEqual({ mode: "each", entries: [{ key: "image__cup", id: "cup" }] });
  });

  it("a pool over the question cap is asked as one choice, same image allowed again", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `m${i}`, name: `m${i}`, url: "u", scene: `条件${i}` }));
    const p = buildContinuityPlan(world({ variables: [], audioTracks: [], sceneImages: many }), state(), input())!;
    expect(Object.keys(p.questions)).toEqual(["image"]);
    const a = { image: { type: "choice" as const, choice: "m3", probabilities: { m3: 0.8, [CONTINUITY_NONE]: 0.1 } } };
    const r1 = applyContinuityPlan(p, a, 5, {});
    expect(r1.imageIds).toEqual(["m3"]);
    expect(applyContinuityPlan(p, a, 6, r1.memory).imageIds).toEqual(["m3"]);
    expect(applyContinuityPlan(p, { image: { type: "choice", choice: CONTINUITY_NONE, probabilities: { [CONTINUITY_NONE]: 0.9 } } }, 7, r1.memory).imageIds).toEqual([]);
  });
});
