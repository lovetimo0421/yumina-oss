import { describe, it, expect } from "vitest";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import { buildSpeakerFormatBlock } from "../prompts/speaker-tag.js";
import { createMockWorld, createMockEntry } from "./test-utils.js";
import type { GameState, WorldEntry } from "../types/index.js";

// The classic editor lets a creator flip an ordinary entry into a character
// (to give it a portrait and a voice). Role must only be a label to prompt
// assembly: the entry keeps its section, position and content.
const state: GameState = { worldId: "w", variables: {}, turnCount: 0, metadata: {} };

function world(role: WorldEntry["role"], extra: Partial<WorldEntry> = {}) {
  return createMockWorld({
    entries: [
      createMockEntry({ id: "main", name: "Mia", role: "character", content: "Mia is {{char}}.", alwaysSend: true, section: "system-presets", position: 0 }),
      createMockEntry({ id: "side", name: "Balder", role, content: "Balder guards the gate. {{char}} knows him.", alwaysSend: true, section: "system-presets", position: 1, ...extra }),
      createMockEntry({ id: "lore", name: "Gate", role: "custom", content: "The gate is old.", alwaysSend: true, section: "system-presets", position: 2 }),
    ],
  });
}

describe("switching an entry to role character", () => {
  it("leaves the assembled system prompt unchanged when an earlier character already defines {{char}}", () => {
    const pb = new PromptBuilder();
    const text = pb.buildSystemMessages(world("character"), state).map((m) => m.content).join("\n");
    expect(text).toContain("Balder guards the gate. Mia knows him.");
    expect(text.indexOf("Mia is Mia.")).toBeLessThan(text.indexOf("Balder guards"));
    for (const from of ["custom", "system", "plot", "scenario", "style"] as const) {
      expect(pb.buildSystemMessages(world("character"), state)).toEqual(pb.buildSystemMessages(world(from), state));
    }
  });

  it("makes the first enabled character the {{char}} name when the world had none", () => {
    // Documented side effect: with no character entry {{char}} falls back to
    // "Assistant"; the first one the creator switches on becomes {{char}}.
    const solo = (role: WorldEntry["role"]) =>
      createMockWorld({ entries: [createMockEntry({ name: "Balder", role, content: "Hi {{char}}", alwaysSend: true })] });
    const pb = new PromptBuilder();
    const txt = (w: ReturnType<typeof solo>) => pb.buildSystemMessages(w, state).map((m) => m.content).join("\n");
    expect(txt(solo("custom"))).toContain("Hi Assistant");
    expect(txt(solo("character"))).toContain("Hi Balder");
  });

  it("only adds the speaker-format block once two characters have portraits", () => {
    expect(buildSpeakerFormatBlock(world("character"))).toBe("");
    const withFaces = createMockWorld({
      entries: world("character", { portrait: "@asset:b" }).entries.map((e) => (e.id === "main" ? { ...e, portrait: "@asset:m" } : e)),
    });
    expect(buildSpeakerFormatBlock(withFaces)).toContain("Mia, Balder");
  });
});
