import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWindowedMessages } from "./agent.js";
import type { ChatMessage } from "../lib/llm/types.js";

// Run through scripts/test-local.mjs (importing the route module boots the
// isolated in-memory database).
const filler = (chars: number) => "x".repeat(chars);
function toolTurn(step: number, resultChars: number): ChatMessage[] {
  return [
    { role: "assistant", content: `Step ${step}`, tool_calls: [
      { id: `call-${step}-a`, type: "function", function: { name: "read_entities", arguments: "{}" } },
      { id: `call-${step}-b`, type: "function", function: { name: "read_entities", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: `call-${step}-a`, content: filler(resultChars) },
    { role: "tool", tool_call_id: `call-${step}-b`, content: filler(resultChars) },
  ];
}

describe("agent context window", () => {
  it("never opens the kept window on a tool result whose tool_calls turn was summarized away", () => {
    // Strict OpenAI-compatible endpoints (DeepSeek official) reject that with
    // "Messages with role 'tool' must be a response to a preceding message
    // with 'tool_calls'". On the 50K deepseek budget a code card hit it every
    // run around step 6–12 (2026-09-18..21).
    const messages: ChatMessage[] = [{ role: "user", content: "Rewrite the phone UI." }];
    // 16 turns × ~4K tokens: over the 50K deepseek budget, and the 70% cut
    // lands inside a result group (the MIN_RECENT clamp does not rescue it).
    for (let step = 0; step < 16; step++) messages.push(...toolTurn(step, 8_000));
    const windowed = buildWindowedMessages(messages, "custom/deepseek-flash");
    assert.ok(windowed.length < messages.length, "The history was compacted");
    assert.equal(windowed[0]!.role, "user");
    assert.match(String(windowed[0]!.content), /Earlier conversation/);
    const firstKept = windowed[2]!;
    assert.notEqual(firstKept.role, "tool", "The kept window must not start with an orphaned tool result");
    for (let i = 0; i < windowed.length; i++) {
      const message = windowed[i]!;
      if (message.role !== "tool") continue;
      // Every kept tool result still follows the assistant turn that called it.
      let owner = i - 1;
      while (owner >= 0 && windowed[owner]!.role === "tool") owner--;
      const previous = windowed[owner]!;
      if (previous.role !== "assistant" || !("tool_calls" in previous)) {
        assert.fail(`tool result ${message.tool_call_id} lost its tool_calls turn`);
      }
      assert.ok(previous.tool_calls?.some((call: { id: string }) => call.id === message.tool_call_id),
        `tool result ${message.tool_call_id} follows a turn that did not call it`);
    }
  });

  it("leaves a history within budget untouched", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Hi" }, ...toolTurn(0, 100), ...toolTurn(1, 100)];
    assert.deepEqual(buildWindowedMessages(messages, "custom/deepseek-flash"), messages);
  });
});
