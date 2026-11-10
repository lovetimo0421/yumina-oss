import { describe, it, expect } from "vitest";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import type { WorldDefinition, WorldEntry, GameState } from "../types/index.js";

function example(content: string): WorldEntry {
  return {
    id: "ex", name: "Example dialogue", content, role: "example", alwaysSend: true, keywords: [],
    conditions: [], conditionLogic: "all", enabled: true, position: 0, section: "examples",
  } as WorldEntry;
}

function turns(content: string) {
  const world = {
    id: "w", name: "Mikasa", description: "", entries: [example(content)], variables: [], rules: [],
    components: [], settings: { playerName: "Eren" },
  } as unknown as WorldDefinition;
  const state: GameState = { worldId: "w", variables: {}, turnCount: 0, metadata: {} };
  return new PromptBuilder().buildExampleMessages(world, state).map((m) => [m.role, m.content]);
}

describe("example dialogue", () => {
  it("reads the SillyTavern format: <START> blocks, {{user}} and {{char}} turns", () => {
    expect(turns("<START>\n{{user}}: Hi.\n{{char}}: Hello.\n<START>\n{{char}}: Again.")).toEqual([
      ["system", "[Example Chat]"], ["user", "Hi."], ["assistant", "Hello."],
      ["system", "[Example Chat]"], ["assistant", "Again."],
    ]);
  });

  it("keeps an example written as prose: it is the AI's voice, not nothing", () => {
    expect(turns("半晌。她抬起手，推开了他。\n\n“别这样。”")).toEqual([
      ["system", "[Example Chat]"], ["assistant", "半晌。她抬起手，推开了他。\n“别这样。”"],
    ]);
  });

  it("reads full-width colons, full-width braces and other cast members' names", () => {
    expect(turns("艾伦：你来了。\n｛｛user｝｝：嗯。\n{{char}}：坐吧。")).toEqual([
      ["system", "[Example Chat]"], ["assistant", "艾伦：你来了。"], ["user", "嗯。"], ["assistant", "坐吧。"],
    ]);
  });

  it("reads bold names and keeps who speaks on a multi-character card", () => {
    expect(turns("**Jennifer:** We shouldn't.\n**Eren**: Why not?\nMikasa: Because.")).toEqual([
      ["system", "[Example Chat]"], ["assistant", "**Jennifer:** We shouldn't."], ["user", "Why not?"], ["assistant", "Because."],
    ]);
  });
});
