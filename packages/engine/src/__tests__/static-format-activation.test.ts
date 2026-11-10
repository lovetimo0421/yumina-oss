import { describe, expect, it } from "vitest";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import { createMockWorld, createMockVariable, createMockGameState } from "./test-utils.js";

const builder = new PromptBuilder();
const gated = createMockVariable({ id: "score", name: "Score", type: "number", defaultValue: 0,
  behaviorRules: "Award points for a completed quest.",
  activation: { mode: "conditions", conditions: [{ variableId: "scene", operator: "eq", value: "story" }], conditionLogic: "all" } });
const world = createMockWorld({ variables: [gated] });
const state = (scene = "cinema") => createMockGameState({ variables: { scene, score: 5 } });

describe("format reference follows the prompt snapshot when supplied", () => {
  it("omits inactive variable rules and directive syntax", () => {
    expect(builder.buildStaticFormatBlock(world, { state: state() })).toBe("");
  });
  it("restores identical ordinary-story syntax when the variable activates", () => {
    expect(builder.buildStaticFormatBlock(world, { state: state("story") })).toBe(builder.buildStaticFormatBlock(world));
  });
  it("preserves state-free callers and explicit empty options", () => {
    const legacy = builder.buildStaticFormatBlock(world);
    expect(legacy).toContain("<directive-format>");
    expect(legacy).toContain(gated.behaviorRules);
    expect(builder.buildStaticFormatBlock(world, {})).toBe(legacy);
  });
  it("keeps the reference stable across value changes with the same eligibility", () => {
    const a = state("story"), b = state("story"); b.variables.score = 900;
    expect(builder.buildStaticFormatBlock(world, { state: a })).toBe(builder.buildStaticFormatBlock(world, { state: b }));
  });
  it("honors runtime disable and restore", () => {
    const s = state("story"); s.ruleState = { ...s.ruleState!, toggledVariables: { score: false } };
    expect(builder.buildStaticFormatBlock(world, { state: s })).toBe("");
    s.ruleState.toggledVariables!.score = true;
    expect(builder.buildStaticFormatBlock(world, { state: s })).toContain("<directive-format>");
  });
  it("honors the active greeting gate", () => {
    const w = createMockWorld({ variables: [{ ...gated, activation: { mode: "greeting", greetingIds: ["first"] } }] });
    const s = state(); s.activeGreetingId = "second";
    expect(builder.buildStaticFormatBlock(w, { state: s })).toBe("");
    s.activeGreetingId = "first";
    expect(builder.buildStaticFormatBlock(w, { state: s })).toContain("<directive-format>");
  });
  it("exposes active read-only rules without inviting state writes", () => {
    const w = createMockWorld({ variables: [{ ...gated, aiAccess: "read" }] });
    const block = builder.buildStaticFormatBlock(w, { state: state("story") });
    expect(block).toContain(gated.behaviorRules);
    expect(block).not.toContain("<directive-format>");
    expect(builder.buildStaticFormatBlock(w, { state: state() })).toBe("");
  });
  it.each([{ internal: true }, { aiAccess: "none" as const }])("never exposes engine-only rules %j", access => {
    const w = createMockWorld({ variables: [{ ...gated, ...access }] });
    expect(builder.buildStaticFormatBlock(w, { state: state("story") })).toBe("");
  });
  it("teaches nested JSON only when an active JSON variable is writable", () => {
    const w = createMockWorld({ variables: [createMockVariable({ id: "hp", type: "number" }),
      { ...gated, id: "bag", type: "json", defaultValue: {} }] });
    const hidden = builder.buildStaticFormatBlock(w, { state: state() });
    expect(hidden).toContain("<directive-format>");
    expect(hidden).not.toContain("JSON variables");
    expect(builder.buildStaticFormatBlock(w, { state: state("story") })).toContain("JSON variables");
    w.variables[1]!.aiAccess = "read";
    expect(builder.buildStaticFormatBlock(w, { state: state("story") })).not.toContain("JSON variables");
  });
  it("preserves audio authority independently of variable writability", () => {
    const w = createMockWorld({ variables: [gated], audioTracks: [
      { id: "wind", name: "Wind", type: "ambient", url: "https://example.test/wind.mp3", loop: true, volume: .4 },
      { id: "ui", name: "UI", type: "sfx", url: "https://example.test/ui.mp3", loop: false, volume: .4, allowAiControl: false },
    ] });
    const block = builder.buildStaticFormatBlock(w, { state: state() });
    expect(block).toContain("wind (ambient)");
    expect(block).not.toContain("ui (sfx)");
    expect(block).not.toContain("<directive-format>");
    expect(block).not.toContain(gated.behaviorRules);
  });
});
