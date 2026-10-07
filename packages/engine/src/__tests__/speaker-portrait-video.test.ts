import { describe, it, expect } from "vitest";
import { buildSpeakerFormatBlock, portraitCharacters, speakerRoster, speakerTagEnabled } from "../prompts/speaker-tag.js";
import type { WorldDefinition, WorldEntry, Worldbook } from "../types/index.js";

const entry = (over: Partial<WorldEntry>): WorldEntry => ({
  id: over.name ?? "e", name: "e", content: "", role: "character", enabled: true,
  keywords: [], position: 0, section: "system-presets", ...over,
} as WorldEntry);

describe("portraitCharacters", () => {
  it("counts a character whose only face is a moving portrait", () => {
    const found = portraitCharacters([
      entry({ name: "Still", portrait: "@asset:a" }),
      entry({ name: "Moving", portraitVideo: { idle: "@asset:b" } }),
      entry({ name: "SpeakingOnly", portraitVideo: { speaking: "@asset:c" } }),
      entry({ name: "Faceless" }),
    ]);
    expect(found.map((e) => e.name)).toEqual(["Still", "Moving"]);
  });
});

describe("a card with an AI of its own", () => {
  // 《雨夜书店》: the brother at the counter is the card's own character, the
  // sister upstairs has an AI of her own. Neither has a portrait.
  const upstairs = { id: "up", name: "二楼", order: 1, activation: { mode: "keywords", keywords: ["二楼"] }, station: { kind: "narrator" } } as Worldbook;
  const shop = (entries: WorldEntry[], worldbooks: Worldbook[] = [upstairs]) =>
    ({ entries, variables: [], worldbooks }) as unknown as WorldDefinition;

  it("asks the model who is talking, naming every character, so her AI can narrate someone else", () => {
    const world = shop([entry({ name: "沈砚" }), entry({ name: "沈霏", worldbookId: "up" })]);
    expect(speakerRoster(world).map((e) => e.name)).toEqual(["沈砚", "沈霏"]);
    expect(speakerTagEnabled(world)).toBe(true);
    const block = buildSpeakerFormatBlock(world);
    expect(block).toContain("Characters: 沈砚, 沈霏.");
    expect(block).toContain("[speaker: narrator]");
  });

  it("leaves a card without such an AI as it was", () => {
    expect(speakerTagEnabled(shop([entry({ name: "沈砚" }), entry({ name: "沈霏" })], []))).toBe(false);
    const faces = shop([entry({ name: "A", portrait: "@asset:a" }), entry({ name: "B", portrait: "@asset:b" })], []);
    expect(buildSpeakerFormatBlock(faces)).toContain("Characters with portraits: A, B.");
  });

  it("does not count a frame whose character has no name yet, or one behind the scenes", () => {
    expect(speakerTagEnabled(shop([entry({ name: "角色", worldbookId: "up" })]))).toBe(false);
    const behind = { ...upstairs, station: { kind: "worker", task: "x", trigger: { on: "turns", every: 3 } } } as Worldbook;
    expect(speakerTagEnabled(shop([entry({ name: "沈霏", worldbookId: "up" })], [behind]))).toBe(false);
  });
});
