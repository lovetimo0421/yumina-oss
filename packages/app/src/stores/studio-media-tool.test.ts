import test from "node:test";
import assert from "node:assert/strict";
import type { StudioChatMessage } from "@/features/studio/lib/types";
import {
  parkedMediaTool,
  withMediaToolAnswer,
  withMediaToolProgress,
  withMediaToolProposal,
  withMediaToolResult,
  type MediaToolProposalEvent,
} from "./studio-media-tool";

const event: MediaToolProposalEvent = {
  runId: "run-1", toolCallId: "call-1", textContent: "I'll cut her out of the background.", tool: "remove-bg",
  inputs: { image: "asset-1" }, output: "image", seconds: 8, amount: 1, priceUsd: 0.01, estimatedMushies: 12,
};
let n = 0;
const newId = () => `m${++n}`;

test("a proposal hangs on the bubble that holds the assistant's sentence, without the server's raw quote", () => {
  const messages: StudioChatMessage[] = [
    { id: "u", role: "user", content: "remove the background" },
    { id: "a", role: "assistant", content: event.textContent, agentRunId: "run-1" },
  ];
  const next = withMediaToolProposal(messages, event, newId);
  assert.equal(next.length, 2);
  assert.deepEqual(next[1]!.mediaToolProposal, {
    runId: "run-1", toolCallId: "call-1", tool: "remove-bg", inputs: { image: "asset-1" }, output: "image", seconds: 8,
    estimatedMushies: 12, status: "pending",
  });
  // Seen again (a reconnect replays it): the same card, not a second one.
  assert.equal(withMediaToolProposal(next, event, newId).filter((m) => m.mediaToolProposal).length, 1);
});

test("with no bubble to hang on, the card gets its own", () => {
  const next = withMediaToolProposal([], { ...event, textContent: "" }, newId);
  assert.equal(next.length, 1);
  assert.equal(next[0]!.role, "assistant");
  assert.equal(next[0]!.mediaToolProposal?.status, "pending");
});

test("run, progress and result move the card along; a late progress never undoes a result", () => {
  let messages = withMediaToolProposal([], event, newId);
  messages = withMediaToolAnswer(messages, "call-1", { approved: true, inputs: { image: "asset-1", note: "edited" } });
  assert.equal(messages[0]!.mediaToolProposal?.status, "running");
  assert.deepEqual(messages[0]!.mediaToolProposal?.inputs, { image: "asset-1", note: "edited" });

  messages = withMediaToolProgress(messages, { toolCallId: "call-1", jobId: "job-1", status: "running", elapsed: 4 });
  assert.equal(messages[0]!.mediaToolProposal?.elapsed, 4);
  assert.equal(messages[0]!.mediaToolProposal?.jobId, "job-1");

  messages = withMediaToolResult(messages, { toolCallId: "call-1", jobId: "job-1", status: "done", assetIds: ["out-1"], costMushies: 12 });
  assert.equal(messages[0]!.mediaToolProposal?.status, "done");
  assert.deepEqual(messages[0]!.mediaToolProposal?.assetIds, ["out-1"]);
  assert.equal(messages[0]!.mediaToolProposal?.costMushies, 12);

  messages = withMediaToolProgress(messages, { toolCallId: "call-1", jobId: "job-1", status: "running", elapsed: 9 });
  assert.equal(messages[0]!.mediaToolProposal?.status, "done");
});

test("a failure keeps its code, a timeout says it is still running, and other cards are left alone", () => {
  const other: StudioChatMessage = { id: "x", role: "assistant", content: "", mediaToolProposal: { ...withMediaToolProposal([], event, newId)[0]!.mediaToolProposal!, toolCallId: "call-2" } };
  let messages = [...withMediaToolProposal([], event, newId), other];
  messages = withMediaToolResult(messages, { toolCallId: "call-1", jobId: null, status: "failed", errorCode: "CONTENT_FILTERED" });
  assert.equal(messages[0]!.mediaToolProposal?.status, "failed");
  assert.equal(messages[0]!.mediaToolProposal?.error, "CONTENT_FILTERED");
  assert.equal(messages[1]!.mediaToolProposal?.status, "pending");
  messages = withMediaToolResult(messages, { toolCallId: "call-2", jobId: "job-2", status: "pending" });
  assert.equal(messages[1]!.mediaToolProposal?.status, "stillRunning");
  assert.equal(withMediaToolAnswer(messages, "call-2", { approved: false })[1]!.mediaToolProposal?.status, "declined");
});

test("a parked call is read back as its tool and inputs; anything else is not", () => {
  assert.deepEqual(parkedMediaTool({ function: { name: "run_media_tool", arguments: JSON.stringify({ tool: "voice", inputs: { text: "hi" } }) } }),
    { tool: "voice", inputs: { text: "hi" } });
  assert.equal(parkedMediaTool({ function: { name: "generate_image", arguments: "{}" } }), null);
  assert.equal(parkedMediaTool({ function: { name: "run_media_tool", arguments: "{oops" } }), null);
  assert.equal(parkedMediaTool(undefined), null);
});
