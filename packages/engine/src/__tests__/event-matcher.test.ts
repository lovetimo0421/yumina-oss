import { describe, it, expect } from "vitest";
import { matchesEventPattern } from "../events/event-matcher.js";

describe("matchesEventPattern", () => {
  it("matches exact event type", () => {
    expect(matchesEventPattern(
      { type: "message:user", content: "hi" },
      { eventType: "message:user" }
    )).toBe(true);
  });

  it("rejects non-matching event type", () => {
    expect(matchesEventPattern(
      { type: "message:ai", content: "hello" },
      { eventType: "message:user" }
    )).toBe(false);
  });

  it("matches wildcard event type", () => {
    expect(matchesEventPattern(
      { type: "spatial:zone-enter", zone: "forest" },
      { eventType: "spatial:*" }
    )).toBe(true);
  });

  it("rejects wildcard when prefix doesn't match", () => {
    expect(matchesEventPattern(
      { type: "message:user" },
      { eventType: "spatial:*" }
    )).toBe(false);
  });

  it("matches with eq condition on data field", () => {
    expect(matchesEventPattern(
      { type: "state:crossed", variableId: "hp", direction: "drops-below" },
      { eventType: "state:crossed", match: { variableId: { operator: "eq", value: "hp" } } }
    )).toBe(true);
  });

  it("rejects when eq condition fails", () => {
    expect(matchesEventPattern(
      { type: "state:crossed", variableId: "mp" },
      { eventType: "state:crossed", match: { variableId: { operator: "eq", value: "hp" } } }
    )).toBe(false);
  });

  it("matches with contains condition", () => {
    expect(matchesEventPattern(
      { type: "message:user", content: "I attack the goblin" },
      { eventType: "message:user", match: { content: { operator: "contains", value: "attack" } } }
    )).toBe(true);
  });

  it("contains is case-insensitive", () => {
    expect(matchesEventPattern(
      { type: "message:user", content: "I ATTACK the goblin" },
      { eventType: "message:user", match: { content: { operator: "contains", value: "attack" } } }
    )).toBe(true);
  });

  it("contains splits comma-separated keywords as OR", () => {
    // Fires whenever ANY keyword appears in the message.
    expect(matchesEventPattern(
      { type: "message:user", content: "let's fight!" },
      { eventType: "message:user", match: { content: { operator: "contains", value: "attack, fight" } } }
    )).toBe(true);
    expect(matchesEventPattern(
      { type: "message:user", content: "I attack" },
      { eventType: "message:user", match: { content: { operator: "contains", value: "attack, fight" } } }
    )).toBe(true);
    expect(matchesEventPattern(
      { type: "message:user", content: "I run away" },
      { eventType: "message:user", match: { content: { operator: "contains", value: "attack, fight" } } }
    )).toBe(false);
  });

  it("contains accepts fullwidth comma and 顿号 as separators", () => {
    expect(matchesEventPattern(
      { type: "message:user", content: "我要旅店" },
      { eventType: "message:user", match: { content: { operator: "contains", value: "酒馆，旅店" } } }
    )).toBe(true);
    expect(matchesEventPattern(
      { type: "message:user", content: "我去酒馆" },
      { eventType: "message:user", match: { content: { operator: "contains", value: "酒馆、旅店、饮料" } } }
    )).toBe(true);
  });

  it("contains rejects when target is empty or only separators", () => {
    expect(matchesEventPattern(
      { type: "message:user", content: "anything" },
      { eventType: "message:user", match: { content: { operator: "contains", value: "" } } }
    )).toBe(false);
    expect(matchesEventPattern(
      { type: "message:user", content: "anything" },
      { eventType: "message:user", match: { content: { operator: "contains", value: " , , " } } }
    )).toBe(false);
  });

  it("matches with gt condition", () => {
    expect(matchesEventPattern(
      { type: "turn:complete", turnCount: 10 },
      { eventType: "turn:complete", match: { turnCount: { operator: "gt", value: 5 } } }
    )).toBe(true);
  });

  it("requires ALL match conditions to pass", () => {
    expect(matchesEventPattern(
      { type: "state:crossed", variableId: "hp", direction: "drops-below" },
      {
        eventType: "state:crossed",
        match: {
          variableId: { operator: "eq", value: "hp" },
          direction: { operator: "eq", value: "rises-above" },
        },
      }
    )).toBe(false);
  });

  it("matches when no match conditions specified", () => {
    expect(matchesEventPattern(
      { type: "turn:complete", turnCount: 5 },
      { eventType: "turn:complete" }
    )).toBe(true);
  });

  it("handles neq operator", () => {
    expect(matchesEventPattern(
      { type: "state:changed", variableId: "gold" },
      { eventType: "state:changed", match: { variableId: { operator: "neq", value: "hp" } } }
    )).toBe(true);
  });
});
