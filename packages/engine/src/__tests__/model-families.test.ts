import { describe, it, expect } from "vitest";
import { MODEL_FAMILIES, familyOf, isModelFamily, type ModelFamily } from "../entries/model-families.js";

describe("familyOf", () => {
  it("maps provider-prefixed ids to their family", () => {
    expect(familyOf("google/gemini-2.5-flash")).toBe("gemini");
    expect(familyOf("anthropic/claude-sonnet-4.6")).toBe("claude");
    expect(familyOf("openai/gpt-5")).toBe("openai");
    expect(familyOf("deepseek/deepseek-v3.2")).toBe("deepseek");
    expect(familyOf("z-ai/glm-4.6")).toBe("glm");
    expect(familyOf("x-ai/grok-4")).toBe("grok");
    expect(familyOf("moonshotai/kimi-k2")).toBe("kimi");
    expect(familyOf("moonshot/kimi")).toBe("kimi");
    expect(familyOf("minimax/minimax-m2")).toBe("minimax");
  });

  it("classifies prefix-less BYOK / local ids by the family word", () => {
    expect(familyOf("gemini-2.5-pro")).toBe("gemini");
    expect(familyOf("gpt-4o")).toBe("openai");
    expect(familyOf("local/kimi-k2-instruct")).toBe("kimi");
    expect(familyOf("glm-4-plus")).toBe("glm");
  });

  it("falls back to 'other' for unknown or empty ids", () => {
    expect(familyOf("mistralai/mistral-large")).toBe("other");
    expect(familyOf("qwen/qwen-max")).toBe("other");
    expect(familyOf("")).toBe("other");
    expect(familyOf(null)).toBe("other");
    expect(familyOf(undefined)).toBe("other");
  });

  it("every family returned is a member of MODEL_FAMILIES", () => {
    const samples = ["google/x", "anthropic/x", "openai/x", "deepseek/x", "z-ai/x", "x-ai/x", "moonshot/x", "minimax/x", "who/knows"];
    for (const s of samples) {
      expect(MODEL_FAMILIES).toContain(familyOf(s) as ModelFamily);
    }
  });
});

describe("isModelFamily", () => {
  it("accepts every listed family and rejects anything else", () => {
    for (const f of MODEL_FAMILIES) expect(isModelFamily(f)).toBe(true);
    expect(isModelFamily("mistral")).toBe(false);
    expect(isModelFamily("")).toBe(false);
    expect(isModelFamily(null)).toBe(false);
    expect(isModelFamily(3)).toBe(false);
  });
});
