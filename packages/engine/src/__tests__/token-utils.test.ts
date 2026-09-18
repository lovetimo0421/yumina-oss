import { describe, it, expect, beforeAll } from "vitest";
import { estimateTokens, preloadTokenizer } from "../prompts/token-utils.js";

// The cl100k_base ranks now load lazily (see token-utils.ts) — await them so
// these tests exercise the exact encoder, not the char heuristic fallback.
beforeAll(() => preloadTokenizer());

it("bounds CPU work for long repeated tokens without under-budgeting them", () => {
  // A creator can paste a long divider or base64-like run into a card. The
  // old quadratic BPE merge took 14 seconds for these 20 KB on a local CPU.
  const start = performance.now();
  const tokens = estimateTokens("A".repeat(20_000));
  expect(tokens).toBeGreaterThanOrEqual(2_500); // exact cl100k count
  expect(tokens).toBeLessThanOrEqual(20_000); // UTF-8 byte upper bound
  expect(performance.now() - start).toBeLessThan(2_000);
});

it("preserves exact ordinary story counts and the model-specific CJK estimate", () => {
  expect(estimateTokens("The plants waited as Dave entered the garden. ".repeat(2000))).toBe(18_001);
  expect(estimateTokens("戴夫走进院子，植物们做好了迎战僵尸的准备。".repeat(4000))).toBe(128_000);
  expect(estimateTokens("戴".repeat(20_000), "google/gemini-2.5-flash")).toBe(20_000);
});

it("handles oversized whitespace and multibyte pieces without losing Unicode boundaries", () => {
  const start = performance.now();
  for (const text of [" ".repeat(20_000), "戴".repeat(20_000), "🙂".repeat(3000)]) {
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThanOrEqual(new TextEncoder().encode(text).length);
  }
  expect(performance.now() - start).toBeLessThan(2_000);
});

describe("estimateTokens", () => {
  describe("default (no model)", () => {
    it("returns 0 for empty string", () => {
      expect(estimateTokens("")).toBe(0);
    });

    it("uses cl100k_base for ASCII", () => {
      // "hello world" is ~2 tokens with cl100k_base
      const tokens = estimateTokens("hello world");
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThanOrEqual(4);
    });

    it("counts Chinese characters as multiple tokens (cl100k overcounts CJK)", () => {
      // cl100k breaks each Chinese char into ~2 BPE tokens
      const tokens = estimateTokens("你好世界");
      expect(tokens).toBeGreaterThanOrEqual(4);
    });
  });

  describe("Gemini model id", () => {
    it("uses CJK-aware estimator", () => {
      // CJK-aware: 4 Chinese chars = 4 tokens
      const tokens = estimateTokens("你好世界", "google/gemini-2.5-flash");
      expect(tokens).toBe(4);
    });

    it("treats ASCII as ~4 chars per token", () => {
      // 12 chars ASCII -> ceil(12/4) = 3
      const tokens = estimateTokens("hello world!", "google/gemini-2.5-pro");
      expect(tokens).toBe(3);
    });

    it("estimates fewer tokens than cl100k for Chinese text", () => {
      // cl100k merges some Chinese chars into single tokens but still costs more
      // per char than Gemini's tokenizer, which approaches ~1 token per CJK char.
      const text = "在一个遥远的星系里，有一颗蓝色的星球。".repeat(50);
      const cl100k = estimateTokens(text);
      const gemini = estimateTokens(text, "google/gemini-2.5-flash");
      expect(gemini).toBeLessThan(cl100k);
    });
  });

  describe("Claude model id", () => {
    it("uses CJK-aware estimator (case-insensitive match)", () => {
      const tokens = estimateTokens("你好世界", "anthropic/Claude-Sonnet-4.6");
      expect(tokens).toBe(4);
    });
  });

  describe("DeepSeek model id", () => {
    // DeepSeek V3/V4 tokenizer is trained on heavy Chinese corpora and merges
    // most Chinese chars into single tokens. cl100k_base would ~2x overestimate
    // and trim history aggressively — e.g. a 42k cap only filling ~20k of the
    // model's real capacity.
    it("uses CJK-aware estimator for DeepSeek V3.2", () => {
      const tokens = estimateTokens("你好世界", "deepseek/deepseek-v3.2");
      expect(tokens).toBe(4);
    });

    it("uses CJK-aware estimator for DeepSeek V4 family", () => {
      const tokens = estimateTokens("你好世界", "deepseek/deepseek-v4-pro");
      expect(tokens).toBe(4);
    });

    it("estimates fewer tokens than cl100k for Chinese text", () => {
      const text = "在一个遥远的星系里，有一颗蓝色的星球。".repeat(50);
      const cl100k = estimateTokens(text);
      const deepseek = estimateTokens(text, "deepseek/deepseek-v4-flash");
      expect(deepseek).toBeLessThan(cl100k);
    });
  });

  describe("non-CJK-aware models", () => {
    it("uses cl100k_base for GPT models", () => {
      // GPT actually uses cl100k_base — same path as default
      const text = "你好世界";
      expect(estimateTokens(text, "openai/gpt-4o")).toBe(estimateTokens(text));
    });

    it("uses cl100k_base for Llama models", () => {
      const text = "你好世界";
      expect(estimateTokens(text, "meta-llama/llama-3.3-70b")).toBe(estimateTokens(text));
    });

    it("uses cl100k_base for Grok models", () => {
      const text = "你好世界";
      expect(estimateTokens(text, "x-ai/grok-4")).toBe(estimateTokens(text));
    });
  });

  describe("CJK boundary characters", () => {
    it("counts hiragana / katakana as CJK", () => {
      // ひらがな = 4 hiragana chars
      const tokens = estimateTokens("ひらがな", "google/gemini-2.5-flash");
      expect(tokens).toBe(4);
    });

    it("counts hangul as CJK", () => {
      // 안녕하세요 = 5 hangul syllable blocks
      const tokens = estimateTokens("안녕하세요", "google/gemini-2.5-flash");
      expect(tokens).toBe(5);
    });

    it("handles mixed CJK + ASCII", () => {
      // "你好 hello" = 2 CJK + 1 space + 5 ASCII = 2 + ceil(6/4) = 2 + 2 = 4
      const tokens = estimateTokens("你好 hello", "google/gemini-2.5-flash");
      expect(tokens).toBe(4);
    });
  });
});
