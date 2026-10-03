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

  it("expands a bare [image: handle] the author typed in an opening", () => {
    // The author copies a handle out of the Scene Images page into their first
    // message; the player must see a picture, not the literal bracket text.
    const world = createMockWorld({
      entries: [
        createMockEntry({
          id: "g1",
          role: "greeting",
          enabled: true,
          position: 1,
          content: "She is already waiting.\n\n[image: img1]",
        }),
      ],
      sceneImages: [
        { id: "img1", name: "Rooftop", url: "@asset:abc-123", scene: "the rooftop" },
      ],
    });
    const [greeting] = new PromptBuilder().buildGreetings(world, {
      worldId: "w",
      variables: {},
      turnCount: 0,
      metadata: {},
    });
    expect(greeting).not.toContain("[image: img1]");
    expect(greeting).toContain("@asset:abc-123");
    expect(greeting).toContain("alt=Rooftop");
    expect(greeting).toContain("She is already waiting.");
  });

  it("drops a handle the author typed for an image that does not exist", () => {
    const world = createMockWorld({
      entries: [
        createMockEntry({ id: "g1", role: "greeting", enabled: true, position: 1, content: "Hi [image: gone] there" }),
      ],
      sceneImages: [{ id: "img1", name: "Lamp", url: "https://example.test/a.png", scene: "the lamp" }],
    });
    const [greeting] = new PromptBuilder().buildGreetings(world, {
      worldId: "w", variables: {}, turnCount: 0, metadata: {},
    });
    expect(greeting).not.toContain("[image:");
    expect(greeting).toContain("Hi");
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
