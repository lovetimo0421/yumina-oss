import assert from "node:assert/strict";
import test from "node:test";
import { supportsAdaptiveThinking, mapEffortToAnthropic, buildAnthropicThinking, parseClaudeVersion, acceptsLegacySamplingParams } from "./anthropic-thinking.js";

test("supportsAdaptiveThinking: 4.6+ and 5.x use adaptive", () => {
  assert.equal(supportsAdaptiveThinking("claude-opus-4-7"), true);
  assert.equal(supportsAdaptiveThinking("claude-opus-4.7"), true); // dot form
  assert.equal(supportsAdaptiveThinking("claude-opus-4-8"), true);
  assert.equal(supportsAdaptiveThinking("claude-sonnet-4-6"), true);
  assert.equal(supportsAdaptiveThinking("claude-fable-5"), true);
});

test("supportsAdaptiveThinking: 4.5 and earlier use the legacy budget shape", () => {
  assert.equal(supportsAdaptiveThinking("claude-opus-4-5"), false);
  assert.equal(supportsAdaptiveThinking("claude-sonnet-4-5"), false);
  assert.equal(supportsAdaptiveThinking("claude-haiku-4-5"), false);
  assert.equal(supportsAdaptiveThinking("claude-opus-4-1"), false);
});

test("mapEffortToAnthropic: UI levels map to accepted effort values", () => {
  assert.equal(mapEffortToAnthropic("minimal"), "low"); // Anthropic has no "minimal"
  assert.equal(mapEffortToAnthropic("low"), "low");
  assert.equal(mapEffortToAnthropic("medium"), "medium");
  assert.equal(mapEffortToAnthropic("high"), "high");
  assert.equal(mapEffortToAnthropic("none"), null);
  assert.equal(mapEffortToAnthropic(undefined), null);
});

test("buildAnthropicThinking: adaptive models emit adaptive + output_config.effort (the ANG 400)", () => {
  assert.deepEqual(
    buildAnthropicThinking("claude-opus-4-7", "low", 4096),
    { thinking: { type: "adaptive" }, output_config: { effort: "low" } },
  );
  assert.deepEqual(
    buildAnthropicThinking("claude-opus-4-8", "high", 32768),
    { thinking: { type: "adaptive" }, output_config: { effort: "high" } },
  );
});

test("buildAnthropicThinking: adaptive models never emit enabled+budget_tokens", () => {
  const body = buildAnthropicThinking("claude-fable-5", "medium", 12288);
  assert.equal((body.thinking as { type: string }).type, "adaptive");
  assert.equal(JSON.stringify(body).includes("budget_tokens"), false);
});

test("buildAnthropicThinking: legacy models keep enabled + budget_tokens", () => {
  assert.deepEqual(
    buildAnthropicThinking("claude-opus-4-5", "low", 4096),
    { thinking: { type: "enabled", budget_tokens: 4096 } },
  );
  assert.deepEqual(
    buildAnthropicThinking("claude-sonnet-4-5", "high", 32768),
    { thinking: { type: "enabled", budget_tokens: 32768 } },
  );
});

test("buildAnthropicThinking: no thinking requested → empty object", () => {
  assert.deepEqual(buildAnthropicThinking("claude-opus-4-7", "none", 0), {});
  assert.deepEqual(buildAnthropicThinking("claude-opus-4-7", undefined, 0), {});
  assert.deepEqual(buildAnthropicThinking("claude-opus-4-5", undefined, 0), {});
});

test("parseClaudeVersion: dash, dot, fable, and unrecognized", () => {
  assert.deepEqual(parseClaudeVersion("claude-opus-4-7"), { major: 4, minor: 7 });
  assert.deepEqual(parseClaudeVersion("claude-opus-4.8"), { major: 4, minor: 8 });
  assert.deepEqual(parseClaudeVersion("claude-sonnet-4-6"), { major: 4, minor: 6 });
  assert.deepEqual(parseClaudeVersion("claude-fable-5"), { major: 5, minor: 0 });
  assert.equal(parseClaudeVersion("claude-3-opus"), null);
});

test("acceptsLegacySamplingParams: 4.7+/5.x reject (the top_p 400), 4.6 and earlier accept", () => {
  assert.equal(acceptsLegacySamplingParams("claude-opus-4-7"), false);
  assert.equal(acceptsLegacySamplingParams("claude-opus-4-8"), false);
  assert.equal(acceptsLegacySamplingParams("claude-fable-5"), false);
  assert.equal(acceptsLegacySamplingParams("claude-opus-4-6"), true);
  assert.equal(acceptsLegacySamplingParams("claude-sonnet-4-6"), true);
  assert.equal(acceptsLegacySamplingParams("claude-opus-4-5"), true);
  assert.equal(acceptsLegacySamplingParams("claude-haiku-4-5"), true);
});
