import { describe, it, expect } from "vitest";
import {
  buildLiveFaceBlock,
  isPartialLeadingSpeakerTag,
  liveCharacters,
  parseLeadingSpeakerTag,
  portraitCharacters,
  stripFaceLines,
} from "../prompts/speaker-tag.js";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import { ResponseParser } from "../parser/response-parser.js";
import { cleanDisplayText } from "../parser/display-text.js";
import { estimateTokens } from "../prompts/token-utils.js";
import type { WorldDefinition, WorldEntry } from "../types/index.js";

const entry = (over: Partial<WorldEntry>): WorldEntry => ({
  id: over.name ?? "e", name: "e", content: "", role: "character", enabled: true,
  keywords: [], position: 0, section: "system-presets", ...over,
} as WorldEntry);

const world = (entries: WorldEntry[], variables: WorldDefinition["variables"] = []) =>
  ({ entries, variables, worldbooks: [], audioTracks: [], settings: {} }) as unknown as WorldDefinition;

const RIG = "@rig:9aaac23e-0000-4000-8000-000000000001";

describe("the face tag", () => {
  it("comes off the start of a reply, alone or after the speaker tag, in either order", () => {
    expect(parseLeadingSpeakerTag("[face: happy]\nHi.")).toEqual({ speaker: null, text: "Hi.", face: "happy" });
    expect(parseLeadingSpeakerTag("[speaker: Yuki]\n[face: shy]\nHi.")).toEqual({ speaker: "Yuki", text: "Hi.", face: "shy" });
    expect(parseLeadingSpeakerTag("[face: 坏笑][speaker: Yuki] Hi.")).toEqual({ speaker: "Yuki", text: " Hi.", face: "坏笑" });
  });

  it("leaves a reply without one exactly as before", () => {
    expect(parseLeadingSpeakerTag("[speaker: Yuki]\nHi.")).toEqual({ speaker: "Yuki", text: "Hi." });
    expect(parseLeadingSpeakerTag("Hi.")).toEqual({ speaker: null, text: "Hi." });
  });

  it("is never a write to a card's own face variable", () => {
    expect(parseLeadingSpeakerTag('[face: set "smile"]\nHi.')).toEqual({ speaker: null, text: '[face: set "smile"]\nHi.' });
  });

  it("holds the bubble while it is still arriving, after the speaker tag too", () => {
    expect(isPartialLeadingSpeakerTag("[fa")).toBe(true);
    expect(isPartialLeadingSpeakerTag("[face: ha")).toBe(true);
    expect(isPartialLeadingSpeakerTag("[speaker: Yuki]\n[fac")).toBe(true);
    expect(isPartialLeadingSpeakerTag("[speaker: Yuki]\n[face: happy]\nH")).toBe(false);
    expect(isPartialLeadingSpeakerTag("[Day 3")).toBe(false);
  });

  it("on a line of its own elsewhere is taken out, and the last one counts", () => {
    expect(stripFaceLines("Hi.\n[face: sad]\n")).toEqual({ text: "Hi.\n\n", face: "sad" });
    expect(stripFaceLines("Her [face: sad] fell.")).toEqual({ text: "Her [face: sad] fell." });
  });

  it("never reaches the story, and the parser says which face it was", () => {
    const parsed = new ResponseParser().parse("[face: surprised]\nOh! You came.\n[mood: set \"glad\"]", undefined, { variableIds: ["mood"] });
    expect(parsed.cleanText).toBe("Oh! You came.");
    expect(parsed.face).toBe("surprised");
    const atEnd = new ResponseParser().parse("Oh! You came.\n\n[face: happy]");
    expect(atEnd.cleanText).toBe("Oh! You came.");
    expect(atEnd.face).toBe("happy");
  });

  it("streams to the sandbox kept on its own line, and off the screen", () => {
    expect(cleanDisplayText("[speaker: Yuki]\n[face: shy]\nHi.", { keepSpeakerTag: true, streaming: true })).toBe("[speaker: Yuki]\n[face: shy]\nHi.");
    expect(cleanDisplayText("[face: shy]\nHi.", { keepSpeakerTag: true, streaming: true })).toBe("[face: shy]\nHi.");
    expect(cleanDisplayText("Hi.\n[face: shy]", { streaming: true })).toBe("Hi.");
  });
});

describe("live characters", () => {
  it("are characters with a live ref, and count as a face for the speaker tag", () => {
    const entries = [
      entry({ name: "Yuki", portraitLive: RIG }),
      entry({ name: "Pack", portraitLive: "@asset:abc" }),
      entry({ name: "Junk", portraitLive: "yuki.rig6" }),
      entry({ name: "Off", portraitLive: RIG, enabled: false }),
    ];
    expect(liveCharacters(entries).map((e) => e.name)).toEqual(["Yuki", "Pack"]);
    expect(portraitCharacters(entries).map((e) => e.name)).toEqual(["Yuki", "Pack"]);
  });
});

describe("the face prompt", () => {
  it("costs nothing on a card without a live character", () => {
    const plain = world([entry({ name: "Yuki", portrait: "@asset:a" })]);
    expect(buildLiveFaceBlock(plain)).toBe("");
    expect(new PromptBuilder().buildStaticFormatBlock(plain)).toBe("");
  });

  it("names the character and the faces, the creator's own ones too, in under 120 tokens", () => {
    const yuki = world([entry({ name: "角色：Yuki", portraitLive: RIG })]);
    const block = buildLiveFaceBlock(yuki, { [RIG]: ["坏笑", "Happy", "bad]name"] });
    expect(block).toContain("Yuki is a live character on screen");
    expect(block).toContain("Begin EVERY reply with the face");
    expect(block).toContain("[face: happy]");
    expect(block).toContain("tilt, 坏笑.");
    expect(block).not.toContain("bad]name");
    expect(block.match(/Happy/g)).toBeNull();
    console.log(`face block: ${estimateTokens(block)} tokens`);
    expect(estimateTokens(block)).toBeLessThan(110);
    expect(new PromptBuilder().buildStaticFormatBlock(yuki, { liveFaces: { [RIG]: ["坏笑"] } })).toContain("<face-format>");
  });

  it("goes after the speaker tag when several characters have faces", () => {
    const two = world([entry({ name: "Yuki", portraitLive: RIG }), entry({ name: "Mia", portrait: "@asset:m" })]);
    const block = new PromptBuilder().buildStaticFormatBlock(two);
    expect(block.indexOf("<speaker-format>")).toBeLessThan(block.indexOf("<face-format>"));
    expect(block).toContain("Right after the speaker tag");
  });

  it("stays out of a card that has a variable called face", () => {
    const owned = world([entry({ name: "Yuki", portraitLive: RIG })], [{ id: "face", name: "face", type: "string", defaultValue: "" } as never]);
    expect(buildLiveFaceBlock(owned)).toBe("");
  });
});
