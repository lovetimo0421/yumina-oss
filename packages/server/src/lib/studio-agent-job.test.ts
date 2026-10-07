import test from "node:test";
import assert from "node:assert/strict";
import { estimateAgentJob } from "./studio-credit-budget.js";
import { CONTROL_TOOL_NAMES, STUDIO_TOOLS } from "./studio-tools/tools.js";
import { buildSystemPrompt } from "./studio-tools/system-prompt.js";

const price = {
  modelId: "anthropic/claude-sonnet-5",
  inputPricePerM: 3,
  outputPricePerM: 15,
  markupMultiplier: 1,
} as unknown as Parameters<typeof estimateAgentJob>[0]["price"];

test("a bigger job is estimated to take longer and cost more", () => {
  const small = estimateAgentJob({ steps: 3, systemTokens: 20_000, conversationTokens: 2_000, price });
  const big = estimateAgentJob({ steps: 10, systemTokens: 20_000, conversationTokens: 2_000, price });
  assert.ok(small.mushies! > 0);
  assert.ok(big.mushies! > small.mushies!);
  assert.ok(big.minutes > small.minutes);
});

test("with the creator's own key there is no mushroom cost to show", () => {
  const estimate = estimateAgentJob({ steps: 5, systemTokens: 20_000, conversationTokens: 2_000, price: null });
  assert.equal(estimate.mushies, null);
  assert.ok(estimate.minutes >= 2);
});

test("estimates read as round numbers, not prices", () => {
  const { mushies } = estimateAgentJob({ steps: 12, systemTokens: 40_000, conversationTokens: 10_000, price });
  if (mushies! >= 20) assert.equal(mushies! % 10, 0);
});

test("propose_job is a control tool the assistant can call", () => {
  assert.ok(CONTROL_TOOL_NAMES.has("propose_job"));
  const def = STUDIO_TOOLS.find((tool) => tool.function.name === "propose_job");
  assert.ok(def);
  assert.match(def!.function.description ?? "", /NOT for a small edit/);
});

test("a started job tells the assistant to finish without asking again", () => {
  const prompt = buildSystemPrompt({ inventory: "", preloadedEntities: "", tokenEstimate: 0, truncated: false, lorebookHealth: { alwaysCount: 0, alwaysTokens: 0, pseudoAlwaysCount: 0, pseudoAlwaysTokens: 0, totalTokens: 0, topEntries: [], overBudget: false, reasons: [] } }, { jobApproved: true });
  assert.match(prompt.dynamic ?? "", /job-approved/);
  assert.match(prompt.dynamic ?? "", /Do not propose the job again/);
});
