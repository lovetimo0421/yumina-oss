import { describe, it, expect } from "vitest";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import { createMockWorld, createMockEntry } from "./test-utils.js";

describe("PromptBuilder.buildGreetingEntries", () => {
  it("returns only enabled greeting entries, sorted by position", () => {
    const world = createMockWorld({
      entries: [
        createMockEntry({ id: "g2", role: "greeting", enabled: true, position: 2 }),
        createMockEntry({ id: "g1", role: "greeting", enabled: true, position: 1 }),
        createMockEntry({ id: "off", role: "greeting", enabled: false, position: 0 }),
        createMockEntry({ id: "lore", role: "lore", enabled: true, position: 0 }),
      ],
    });
    const pb = new PromptBuilder();
    expect(pb.buildGreetingEntries(world).map((e) => e.id)).toEqual(["g1", "g2"]);
  });

  it("aligns index-for-index with buildGreetings", () => {
    const world = createMockWorld({
      entries: [
        createMockEntry({ id: "b", role: "greeting", enabled: true, position: 5, content: "Bravo" }),
        createMockEntry({ id: "a", role: "greeting", enabled: true, position: 1, content: "Alpha" }),
      ],
    });
    const pb = new PromptBuilder();
    const entries = pb.buildGreetingEntries(world);
    const strings = pb.buildGreetings(world, {
      worldId: "w",
      variables: {},
      turnCount: 0,
      metadata: {},
    });
    expect(entries.map((e) => e.content)).toEqual(strings);
  });
});
