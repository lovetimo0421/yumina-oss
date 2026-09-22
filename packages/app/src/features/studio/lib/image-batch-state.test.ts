import assert from "node:assert/strict";
import test from "node:test";
import { serializeStudioChatMessages, type StudioImageBatchProposal } from "./types";
import { defaultImageBatchSelection, imageBatchRetryIds, matchingImageBatch, proposalWithImageBatch,
  sameImageBatchCardScope, selectedImageBatchItems } from "./image-batch-state";

import { proposal, snapshot } from "./image-batch-test-fixtures";

test("batch selection skips existing portraits and passes separate edited prompts", () => {
  const selected = defaultImageBatchSelection(proposal.items);
  assert.deepEqual([...selected], ["red", "blue"]);
  selected.add("existing");
  assert.deepEqual(selectedImageBatchItems(proposal.items, selected, { red: "  Red hair, outdoor portrait  " }),
    [{ id: "red", prompt: "Red hair, outdoor portrait" }, { id: "blue", prompt: "A girl with blue hair" }]);
  assert.deepEqual(selectedImageBatchItems(proposal.items, new Set(), {}), []);
});

test("restoring and serializing a batch retains delivered assets, billing and failure state", () => {
  const batch = snapshot();
  assert.equal(matchingImageBatch(proposal, "other-world", [batch]), undefined);
  assert.equal(matchingImageBatch({ ...proposal, toolCallId: "other-tool" }, "world-one", [batch]), undefined);
  const restored = proposalWithImageBatch(proposal, matchingImageBatch(proposal, "world-one", [batch])!);
  const messages = serializeStudioChatMessages([{ id: "message", role: "assistant", content: "", imageBatchProposal: restored }]);
  const saved = JSON.parse(JSON.stringify(messages))[0].imageBatchProposal as StudioImageBatchProposal;
  assert.equal(saved.status, "submitted");
  assert.equal(saved.batch?.items[0]?.assetId, "asset-red");
  assert.equal(saved.batch?.costMushies, 35);
  assert.deepEqual(imageBatchRetryIds(saved.batch!), ["blue"]);
  saved.batch!.items[1]!.status = "binding_failed";
  saved.batch!.items[1]!.assetId = "asset-blue";
  assert.deepEqual(imageBatchRetryIds(saved.batch!), ["blue"], "retry also supports assignment of an already generated asset");
});

test("poll responses belong to one account, world, conversation, run and card", () => {
  const scope = { owner: "alice", worldId: "world-one", conversationId: "conversation-one", runId: "run-one", toolCallId: "tool-one" };
  assert.equal(sameImageBatchCardScope(scope, { ...scope }), true);
  for (const field of Object.keys(scope) as Array<keyof typeof scope>) {
    assert.equal(sameImageBatchCardScope(scope, { ...scope, [field]: "other" }), false, field);
  }
  assert.equal(sameImageBatchCardScope({ ...scope, owner: null }, { ...scope, owner: null }), false);
});
