import { describe, it, expect } from "vitest";
import { keywordMatches } from "../keyword-matcher.js";

const whole = (text: string, kw: string) => keywordMatches(text, kw, true);

describe("keywordMatches whole words", () => {
  it("still keeps Latin keywords to whole words", () => {
    expect(whole("Ron grabs your sleeve.", "Ron")).toBe(true);
    expect(whole("Ron's ears go red.", "Ron")).toBe(true);
    expect(whole("Something feels wrong.", "Ron")).toBe(false);
    expect(whole("Ronald Weasley, honestly.", "Ron")).toBe(false);
    expect(whole("She is in the bathroom.", "aunt")).toBe(false);
    expect(whole("chapter 10 begins", "chapter 1")).toBe(false);
    expect(whole("chapter 1 begins", "chapter 1")).toBe(true);
    expect(whole("RON!", "ron")).toBe(true);
  });

  it("matches Chinese, Japanese and Korean keywords inside running text", () => {
    expect(whole("赫敏皱着眉往这儿看。", "赫敏")).toBe(true);
    expect(whole("潘西·帕金森站在门口", "潘西")).toBe(true);
    expect(whole("第1章开始了", "第1章")).toBe(true);
    expect(whole("第11章开始了", "第1章")).toBe(false);
    expect(whole("ハーマイオニーが笑った", "ハーマイオニー")).toBe(true);
    expect(whole("론이 웃었다", "론")).toBe(true);
    expect(whole("罗恩来了", "赫敏")).toBe(false);
  });

  it("puts a boundary only on the side whose character is space-separated", () => {
    expect(whole("我去了Hogsmeade村", "Hogsmeade")).toBe(true);
    expect(whole("Hogsmeade村的店", "Hogsmeade村")).toBe(true);
    expect(whole("Hogsmeadevillage", "Hogsmeade")).toBe(false);
  });

  it("handles accented Latin letters as part of the word", () => {
    expect(whole("José llega tarde.", "José")).toBe(true);
    expect(whole("Secré Swallowtail", "Secré")).toBe(true);
    expect(whole("un café caliente", "caf")).toBe(false);
  });

  it("matches keywords that start or end with punctuation", () => {
    expect(whole("I write C++ at night", "C++")).toBe(true);
    expect(whole("tag #duel now", "#duel")).toBe(true);
  });

  it("leaves substring and regex keywords as they were", () => {
    expect(keywordMatches("Something feels wrong.", "Ron", false)).toBe(true);
    expect(keywordMatches("Ron arrives", "/\\bRon\\b/", false)).toBe(true);
    expect(keywordMatches("wrong", "/\\bRon\\b/", false)).toBe(false);
  });
});
