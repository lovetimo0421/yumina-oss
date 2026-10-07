import { describe, it, expect } from "vitest";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import { createMockWorld, createMockVariable, createMockGameState } from "./test-utils.js";

/**
 * The author's Context options: a pinned note that rides with the depth
 * entries, and how much of the variable state the story AI is shown.
 */
describe("Context options", () => {
  const builder = new PromptBuilder();

  describe("pinned note", () => {
    it("is delivered as one more depth injection, default depth 1, system role", () => {
      const world = createMockWorld({ settings: { pinnedNote: { content: "Keep {{user}} in second person." }, playerName: "Mira" } as never });
      const state = createMockGameState();
      const depth = builder.buildDepthEntries(world, state);
      expect(depth).toHaveLength(1);
      expect(depth[0]).toMatchObject({ depth: 1, apiRole: "system" });
      expect(depth[0]!.content).toContain("Mira");
    });

    it("keeps the author's depth and role, and a blank note is no note", () => {
      const world = createMockWorld({ settings: { pinnedNote: { content: "  Stay in scene.  ", depth: 3, apiRole: "user" } } as never });
      const state = createMockGameState();
      expect(builder.buildDepthEntries(world, state)[0]).toMatchObject({ depth: 3, apiRole: "user" });
      const blank = createMockWorld({ settings: { pinnedNote: { content: "   " } } as never });
      expect(builder.buildDepthEntries(blank, state)).toHaveLength(0);
      expect(builder.buildPinnedNote(blank, state)).toBeNull();
    });

    it("counts toward the prompt cost breakdown", () => {
      const world = createMockWorld({ settings: { pinnedNote: { content: "Never skip the weather." } } as never });
      const blocks = builder.buildPromptCostBreakdown(world, createMockGameState()).blocks;
      expect(blocks.some((b) => b.label === "Pinned note" && b.tokens > 0)).toBe(true);
    });
  });

  describe("variablesToAi", () => {
    const vars = () => [
      createMockVariable({ id: "hp", type: "number", defaultValue: 100 }),
      createMockVariable({ id: "mood", type: "string", defaultValue: "calm" }),
    ];

    it("'all' (the default) shows every readable variable", () => {
      const world = createMockWorld({ variables: vars() });
      const state = createMockGameState({ variables: { hp: 100, mood: "calm" } });
      const block = builder.buildFormatBlock(world, state);
      expect(block).toContain("hp: 100");
      expect(block).toContain("mood: calm");
    });

    it("'changed' shows only what moved off its default", () => {
      const world = createMockWorld({ variables: vars(), settings: { variablesToAi: "changed" } as never });
      const state = createMockGameState({ variables: { hp: 42, mood: "calm" } });
      const block = builder.buildFormatBlock(world, state);
      expect(block).toContain("hp: 42");
      expect(block).not.toContain("mood:");
    });

    it("'changed' with nothing changed, and 'none', send no state block at all", () => {
      const quiet = createMockWorld({ variables: vars(), settings: { variablesToAi: "changed" } as never });
      expect(builder.buildFormatBlock(quiet, createMockGameState({ variables: { hp: 100, mood: "calm" } }))).toBe("");
      const none = createMockWorld({ variables: vars(), settings: { variablesToAi: "none" } as never });
      expect(builder.buildFormatBlock(none, createMockGameState({ variables: { hp: 1, mood: "x" } }))).toBe("");
    });
  });
});
