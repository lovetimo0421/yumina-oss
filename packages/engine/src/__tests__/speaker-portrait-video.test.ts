import { describe, it, expect } from "vitest";
import { portraitCharacters } from "../prompts/speaker-tag.js";
import type { WorldEntry } from "../types/index.js";

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
