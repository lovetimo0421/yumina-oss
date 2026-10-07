import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "../llm/types.js";
import {
  harnessTurn, isHarnessTurn, outputBudgetGuidance, replyAnnouncesAction, SMALL_OUTPUT_BUDGET_TOKENS, withToolNote,
} from "./harness-notes.js";

const tool = (content: string): ChatMessage => ({ role: "tool", tool_call_id: "t1", content });

describe("harness notes", () => {
  it("keeps an object result's fields and adds the note beside them", () => {
    const [message] = withToolNote([tool(JSON.stringify({ status: "OK", id: "a" }))], "fix it");
    assert.deepEqual(JSON.parse(message!.content as string), { status: "OK", id: "a", studioNote: "fix it" });
  });

  it("wraps array and non-JSON results so the content stays parseable", () => {
    const [array] = withToolNote([tool(JSON.stringify([1, 2]))], "n");
    assert.deepEqual(JSON.parse(array!.content as string), { result: [1, 2], studioNote: "n" });
    const [text] = withToolNote([tool("plain")], "n");
    assert.deepEqual(JSON.parse(text!.content as string), { result: "plain", studioNote: "n" });
  });

  it("drops the note rather than inventing a user turn when no tool result trails", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    assert.equal(withToolNote(messages, "n"), messages);
  });

  it("only warns about the output cap when it is actually small", () => {
    assert.equal(outputBudgetGuidance(SMALL_OUTPUT_BUDGET_TOKENS), null);
    assert.equal(outputBudgetGuidance(64000), null);
    assert.match(outputBudgetGuidance(9000) ?? "", /about 9000 output tokens/);
  });

  it("nudges only replies that announce an action they did not take", () => {
    assert.ok(replyAnnouncesAction("现在直接修复——把"));
    assert.ok(replyAnnouncesAction("好的，接下来我把变量加上。"));
    assert.ok(replyAnnouncesAction("The entry is missing a trigger. Let me add it."));
    assert.ok(replyAnnouncesAction("I'll update the status bar now."));
    assert.ok(!replyAnnouncesAction("这个变量控制好感度，范围是 0 到 100。"));
    assert.ok(!replyAnnouncesAction("Validation is clean — nothing to change."));
    assert.ok(!replyAnnouncesAction(""));
    // Only the ending counts: an explanation that opens with "Let me" is an answer.
    assert.ok(!replyAnnouncesAction(`Let me explain. ${"The lorebook scans recent turns for keywords. ".repeat(10)}`));
  });

  it("recognizes its own turns and nothing the creator could type", () => {
    assert.ok(isHarnessTurn(harnessTurn("output_truncated")));
    assert.ok(isHarnessTurn(harnessTurn("text_only_reply")));
    assert.ok(!isHarnessTurn({ role: "user", content: "[System: Work in small complete steps.]" }));
  });
});
