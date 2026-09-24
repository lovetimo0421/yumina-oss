import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "../llm/types.js";
import {
  harnessTurn, isHarnessTurn, outputBudgetGuidance, SMALL_OUTPUT_BUDGET_TOKENS, withToolNote,
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

  it("recognizes its own turns and nothing the creator could type", () => {
    assert.ok(isHarnessTurn(harnessTurn("output_truncated")));
    assert.ok(isHarnessTurn(harnessTurn("text_only_reply")));
    assert.ok(!isHarnessTurn({ role: "user", content: "[System: Work in small complete steps.]" }));
  });
});
