import assert from "node:assert/strict";
import test from "node:test";
import { latestBuildProposal, handoffKey, hasSeenBuildOffer, markBuildOfferSeen } from "./build-handoff";
import { serializeStudioChatMessages, type StudioChatMessage } from "./types";

const proposal = { revision: "a".repeat(64), brief: "Rainy port", summary: "Build the opening", steps: ["Opening", "Trust"] };
test("offers survive final prose and serialization, but not a new user request", () => {
  const messages: StudioChatMessage[] = [
    { id: "user", role: "user", content: "Make a port" },
    { id: "plan", role: "assistant", content: "", buildProposal: proposal },
    { id: "wrap", role: "assistant", content: "Ready to build." },
  ];
  assert.deepEqual(latestBuildProposal(messages), proposal);
  assert.deepEqual(serializeStudioChatMessages(messages)[1]!.buildProposal, proposal);
  assert.equal(latestBuildProposal([...messages, { id: "new", role: "user", content: "Change the ending" }]), null);
  assert.equal(latestBuildProposal([{ id: "bad", role: "assistant", content: "", buildProposal: { ...proposal, steps: [] } }]), null);
});
test("a seen plan stays quiet in the same conversation, with storage unavailable", () => {
  const key = handoffKey("world", "conversation", proposal.revision);
  assert.equal(hasSeenBuildOffer(key), false);
  markBuildOfferSeen(key);
  assert.equal(hasSeenBuildOffer(key), true);
  assert.equal(hasSeenBuildOffer(handoffKey("world", "other", proposal.revision)), false);
  assert.equal(hasSeenBuildOffer(handoffKey("world", "conversation", "b".repeat(64))), false);
});
