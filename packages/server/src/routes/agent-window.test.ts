import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWindowedMessages, getContextBudget } from "./agent.js";
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

  it("carries the checklist into the summary when its last update was summarized away", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Build the romance system." },
      { role: "assistant", content: "Planning", tool_calls: [{ id: "plan-1", type: "function", function: {
        name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "角色条目", status: "completed" }, { step: "好感变量", status: "in_progress" }] }) } }] },
      { role: "tool", tool_call_id: "plan-1", content: "{\"shown\":true}" },
    ];
    for (let step = 0; step < 16; step++) messages.push(...toolTurn(step, 8_000));
    const windowed = buildWindowedMessages(messages, "custom/deepseek-flash");
    const summary = String(windowed[0]!.content);
    assert.match(summary, /Earlier conversation/);
    assert.match(summary, /\[x\] 角色条目\n\[>\] 好感变量/);
  });

  it("leaves a history within budget untouched", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Hi" }, ...toolTurn(0, 100), ...toolTurn(1, 100)];
    assert.deepEqual(buildWindowedMessages(messages, "custom/deepseek-flash"), messages);
  });

  it("sizes a catalog model by its real window, a custom endpoint by its name", () => {
    // ~64K tokens: over the 50K name rule for "deepseek", far under DeepSeek V4's 1M window.
    const messages: ChatMessage[] = [{ role: "user", content: "Rewrite the phone UI." }];
    for (let step = 0; step < 16; step++) messages.push(...toolTurn(step, 8_000));
    assert.ok(buildWindowedMessages(messages, "custom/deepseek-flash").length < messages.length);
    assert.deepEqual(buildWindowedMessages(messages, "deepseek/deepseek-v4-pro"), messages);
  });

  it("keeps the creator's pasted text word for word, and drops loop-authored turns", () => {
    const paste = `第一章 ${"雨夜。".repeat(800)} 结尾：她回头了。`;
    const messages: ChatMessage[] = [
      { role: "user", content: paste },
      { role: "user", content: "[System: Your previous response was cut off by the output token limit before you could complete your tool call. Please continue — call the tool now without repeating your reasoning.]" },
    ];
    for (let step = 0; step < 16; step++) messages.push(...toolTurn(step, 8_000));
    const summary = String(buildWindowedMessages(messages, "custom/deepseek-flash")[0]!.content);
    assert.ok(summary.includes(paste), "The whole paste survives the summary");
    assert.ok(!summary.includes("[System:"), "Harness turns are not the creator's words");
  });
});

describe("getContextBudget", () => {
  // window, reply, preloaded card and fixed prompt must all fit together.
  const fits = (model: string, window: number, byName: number) =>
    getContextBudget(model) + 64_000 + Math.ceil(byName * 0.45) + 40_000 <= window;

  it("lets a 1M-window model keep far more history than its name rule did", () => {
    assert.equal(getContextBudget("deepseek/deepseek-v4-flash"), 200_000);
  });
  it("keeps a 262K window from overflowing on a long run", () => {
    const budget = getContextBudget("moonshotai/kimi-k2.6");
    assert.ok(budget > 75_000 && fits("moonshotai/kimi-k2.6", 262_144, 75_000), `budget ${budget}`);
  });
  it("never lowers a small window below what the name rule gave it", () => {
    assert.equal(getContextBudget("deepseek/deepseek-v3.2"), 50_000);
    assert.equal(getContextBudget("anthropic/claude-haiku-4.5"), 120_000);
  });
});
