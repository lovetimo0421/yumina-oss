import { describe, it, expect } from "vitest";
import { buildBackgroundPromptBlock, resolveBackgroundDirectives } from "./background-directives.js";
import type { BackgroundImage } from "../types/index.js";

const bg = (id: string, over: Partial<BackgroundImage> = {}): BackgroundImage => ({
  id,
  name: id,
  url: `https://example.test/${id}.jpg`,
  ...over,
});

describe("resolveBackgroundDirectives", () => {
  const list = [bg("bg1", { name: "Rooftop" }), bg("bg2", { name: "Classroom" })];

  it("leaves text alone when there is no directive", () => {
    const r = resolveBackgroundDirectives("She said nothing.", list);
    expect(r.text).toBe("She said nothing.");
    expect(r.backgroundId).toBeNull();
  });

  it("strips the directive and reports the handle", () => {
    const r = resolveBackgroundDirectives("You climb the stairs.\n\n[bg: bg1]\n\nThe city is below.", list);
    expect(r.backgroundId).toBe("bg1");
    expect(r.text).not.toContain("[bg:");
    expect(r.text).toContain("You climb the stairs.");
    expect(r.text).toContain("The city is below.");
  });

  it("takes the last handle when a reply moves twice", () => {
    const r = resolveBackgroundDirectives("[bg: bg1] out and [bg: bg2] in", list);
    expect(r.backgroundId).toBe("bg2");
  });

  it("matches by name and ignores case", () => {
    expect(resolveBackgroundDirectives("[bg: CLASSROOM]", list).backgroundId).toBe("bg2");
    expect(resolveBackgroundDirectives("[bg: BG1]", list).backgroundId).toBe("bg1");
  });

  it("drops an invented handle without leaving bracket noise", () => {
    const r = resolveBackgroundDirectives("Hello [bg: nowhere] there", list);
    expect(r.backgroundId).toBeNull();
    expect(r.text).not.toContain("[bg:");
    expect(r.text).toContain("Hello");
  });

  it("collapses the blank line a stripped directive leaves behind", () => {
    const r = resolveBackgroundDirectives("One.\n\n[bg: bg1]\n\nTwo.", list);
    expect(r.text).toBe("One.\n\nTwo.");
  });
});

describe("buildBackgroundPromptBlock", () => {
  it("lists each handle with its sentence", () => {
    const block = buildBackgroundPromptBlock([bg("bg1", { scene: "a rainy night" })]);
    expect(block).toContain("- bg1: a rainy night");
    expect(block).toContain("<backgrounds>");
    expect(block).toContain("</backgrounds>");
  });

  it("falls back to the name when there is no sentence", () => {
    expect(buildBackgroundPromptBlock([bg("bg2", { name: "Classroom" })])).toContain("- bg2: Classroom");
  });
});
