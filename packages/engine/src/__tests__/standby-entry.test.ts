import { describe, it, expect, beforeEach } from "vitest";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import { LorebookMatcher } from "../lorebook/lorebook-matcher.js";
import { isStandbyOn } from "../lorebook/entry-triggers.js";
import { createMockWorld, createMockEntry, createMockGameState, resetIdCounter } from "./test-utils.js";
import type { GameState } from "../types/index.js";

// The canvas files an entry with no keywords, no conditions and no every-turn
// switch under 待命设定 ("由行为开关"). A behaviour's 启用词条 has to put it in
// front of the AI from then on — and a keyword entry that starts off has to
// start matching once it is switched on.

const withToggles = (state: GameState, toggled: Record<string, boolean>): GameState => ({
  ...state,
  ruleState: { ...(state.ruleState ?? {}), toggledEntries: toggled } as GameState["ruleState"],
});

describe("standby entries switched on by a behaviour", () => {
  beforeEach(() => resetIdCounter());

  const standby = () => createMockEntry({ id: "heart", content: "SHE LIKES YOU", alwaysSend: false, enabled: false, keywords: [], conditions: [] });

  it("reach the system prompt once switched on, and not before", () => {
    const world = createMockWorld({ entries: [standby()] });
    const off = createMockGameState();
    const on = withToggles(off, { heart: true });
    const pb = new PromptBuilder();
    expect(pb.buildSystemPrompt(world, off, undefined, undefined, undefined, off.ruleState?.toggledEntries)).not.toContain("SHE LIKES YOU");
    expect(pb.buildSystemPrompt(world, on, undefined, undefined, undefined, { heart: true })).toContain("SHE LIKES YOU");
  });

  it("come back from the matcher as every-turn entries, so they are not injected twice", () => {
    const world = createMockWorld({ entries: [standby()] });
    const on = withToggles(createMockGameState(), { heart: true });
    const result = new LorebookMatcher().matchWithBudget(world.entries, ["hello"], on);
    expect(result.alwaysSend.map((e) => e.id)).toEqual(["heart"]);
    expect(result.triggered).toEqual([]);
    const triggered = new PromptBuilder().buildTriggeredSystemMessages(world, on, [standby()], { heart: true });
    expect(triggered).toEqual([]);
  });

  it("a keyword entry that starts off matches once a behaviour switches it on", () => {
    const entry = createMockEntry({ id: "cellar", content: "CELLAR LORE", alwaysSend: false, enabled: false, keywords: ["cellar"], conditions: [] });
    const off = createMockGameState();
    const matcher = new LorebookMatcher();
    expect(matcher.matchWithBudget([entry], ["down to the cellar"], off).triggered).toEqual([]);
    const on = withToggles(off, { cellar: true });
    expect(matcher.matchWithBudget([entry], ["down to the cellar"], on).triggered.map((e) => e.id)).toEqual(["cellar"]);
  });

  it("only standby entries are forced every turn", () => {
    const keyword = createMockEntry({ id: "k", alwaysSend: false, keywords: ["x"], conditions: [] });
    expect(isStandbyOn(keyword, { k: true })).toBe(false);
    expect(isStandbyOn(standby(), { heart: false })).toBe(false);
    expect(isStandbyOn(standby(), { heart: true }, [{ entryId: "heart", slotId: "s1" } as never])).toBe(false);
    expect(isStandbyOn(standby(), { heart: true })).toBe(true);
  });
});
