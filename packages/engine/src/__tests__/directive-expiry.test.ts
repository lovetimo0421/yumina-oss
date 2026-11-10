import { describe, it, expect } from "vitest";
import { GameStateManager } from "../state/game-state-manager.js";
import { createMockWorld } from "./test-utils.js";

// The send path's order: expire what ran out, then start the turn, then build
// the prompt from the snapshot. A behaviour fired during turn N stamps
// injectedAtTurn = N; "for d turns" must reach the next d replies and no more.
function promptsCarrying(duration: number | undefined, sends: number): number[] {
  const sm = new GameStateManager(createMockWorld({ variables: [] }));
  sm.incrementTurn(); // turn 1 is being played; its behaviour pins a line
  sm.injectDirective({ id: "omen", content: "x", position: "bottom", sourceRuleId: "", persistent: true, injectedAtTurn: sm.getSnapshot().turnCount, duration });
  const carried: number[] = [];
  for (let i = 0; i < sends; i++) {
    sm.expireDirectives(sm.getSnapshot().turnCount);
    sm.incrementTurn();
    if (sm.getSnapshot().ruleState.activeDirectives.some((d) => d.id === "omen")) carried.push(sm.getSnapshot().turnCount);
  }
  return carried;
}

describe("timed directives", () => {
  it("a one-turn directive reaches only the next reply", () => {
    expect(promptsCarrying(1, 4)).toEqual([2]);
  });
  it("a two-turn directive reaches the next two replies", () => {
    expect(promptsCarrying(2, 5)).toEqual([2, 3]);
  });
  it("a directive with no duration stays", () => {
    expect(promptsCarrying(undefined, 4)).toEqual([2, 3, 4, 5]);
  });
});

describe("one-shot directives", () => {
  it("persistent:false with no duration lasts one turn", () => {
    const sm = new GameStateManager(createMockWorld({ variables: [] }));
    sm.incrementTurn();
    sm.injectDirective({ id: "once", content: "x", position: "auto", sourceRuleId: "", persistent: false, injectedAtTurn: sm.getSnapshot().turnCount });
    const carried: number[] = [];
    for (let i = 0; i < 3; i++) {
      sm.expireDirectives(sm.getSnapshot().turnCount);
      sm.incrementTurn();
      if (sm.getSnapshot().ruleState.activeDirectives.some((d) => d.id === "once")) carried.push(sm.getSnapshot().turnCount);
    }
    expect(carried).toEqual([2]);
  });
});

describe("directive positions", () => {
  it("a depth or unknown position is sent with the auto directives, not dropped", async () => {
    const { PromptBuilder } = await import("../prompts/prompt-builder.js");
    const { createMockGameState } = await import("./test-utils.js");
    const pb = new PromptBuilder();
    const world = createMockWorld({ variables: [] });
    const state = createMockGameState();
    const d = (id: string, position: string) => ({ id, content: `PIN_${id.toUpperCase()}`, position, sourceRuleId: "", persistent: true, injectedAtTurn: 0 }) as never;
    const text = pb.buildSystemMessages(world, state, undefined, undefined, [d("auto", "auto"), d("depth", "depth"), d("odd", "sideways"), d("bottom", "bottom")])
      .map((m) => m.content).join("\n");
    for (const id of ["AUTO", "DEPTH", "ODD", "BOTTOM"]) expect(text).toContain(`PIN_${id}`);
  });
});
