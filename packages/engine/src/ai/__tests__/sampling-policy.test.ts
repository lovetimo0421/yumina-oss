import { describe, it, expect } from "vitest";
import { clampAuthorSampling, resolveStorySampling } from "../sampling-policy.js";
import { extractAiCallsFromFiles } from "../../graph/ai-call-scan.js";

describe("resolveStorySampling", () => {
  it("lets the player's settings win by default and fills gaps from the card", () => {
    expect(resolveStorySampling({ temperature: 0.3, topP: 0.8 }, { temperature: 1 })).toEqual({ temperature: 1, topP: 0.8 });
  });

  it("lets an author-locked card win, clamped to safe ranges", () => {
    const sampling = resolveStorySampling(
      { samplingPolicy: "author", temperature: 2, topK: 1_000_000 },
      { temperature: 0.7, topP: 0.9 },
    );
    expect(sampling).toEqual({ temperature: 1.5, topK: 200, topP: 0.9 });
  });

  it("drops values that are not numbers", () => {
    expect(clampAuthorSampling({ temperature: "hot", minP: 0.9 })).toEqual({ minP: 0.5 });
  });
});

describe("extractAiCallsFromFiles sampling literals", () => {
  it("reads literal temperature and maxTokens", () => {
    const [call] = extractAiCallsFromFiles({ "a.tsx": "api.ai.complete({ messages, temperature: 0.4, maxTokens: 600 })" });
    expect(call).toMatchObject({ temperature: 0.4, maxTokens: 600 });
    expect(call!.dynamicSampling).toBeUndefined();
  });

  it("flags computed sampling instead of guessing", () => {
    const [call] = extractAiCallsFromFiles({ "b.tsx": "api.ai.complete({ messages, temperature: mood > 3 ? 1 : 0.2, maxTokens })" });
    expect(call!.temperature).toBeUndefined();
    expect(call!.dynamicSampling).toBe(true);
  });
});
