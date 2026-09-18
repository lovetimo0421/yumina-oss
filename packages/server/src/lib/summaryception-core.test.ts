import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function loadModule() {
  return import("./summaryception-core.js");
}

test("normalizes summary implementation with localdev default", async () => {
  const { normalizeSessionSummaryImplementation } = await loadModule();
  assert.equal(normalizeSessionSummaryImplementation("summaryception"), "summaryception");
  assert.equal(normalizeSessionSummaryImplementation("localdev"), "localdev");
  assert.equal(normalizeSessionSummaryImplementation("unexpected"), "localdev");
  assert.equal(normalizeSessionSummaryImplementation(null), "localdev");
});

test("assembles Summaryception snippets from deepest layer to newest raw layer", async () => {
  const { assembleSummaryceptionText } = await loadModule();
  const text = assembleSummaryceptionText([
    { layerIndex: 0, snippetOrder: 1, text: "Layer zero second." },
    { layerIndex: 2, snippetOrder: 0, text: "Deepest continuity." },
    { layerIndex: 0, snippetOrder: 0, text: "Layer zero first." },
    { layerIndex: 1, snippetOrder: 0, text: "Middle continuity." },
  ]);

  assert.equal(text, "Deepest continuity. Middle continuity. Layer zero first. Layer zero second.");
});

test("formats Summaryception prompt block without exposing snippet controls", async () => {
  const { formatSummaryceptionForPrompt } = await loadModule();
  assert.equal(formatSummaryceptionForPrompt([]), null);
  assert.equal(
    formatSummaryceptionForPrompt([{ layerIndex: 0, snippetOrder: 0, text: "The vow remains unresolved." }]),
    "<summary>\nThe vow remains unresolved.\n</summary>\n[The following is the current live roleplay, continuing from the above summary.]",
  );
});

test("layered generation and promotion share one language check and disable correction retries", () => {
  const source = readFileSync(new URL("./summaryception.ts", import.meta.url), "utf8");
  const wrapper = source.slice(source.indexOf("async function generateSummaryceptionText("), source.indexOf("function buildSummaryceptionPrompt("));
  assert.match(wrapper, /return correctSummaryLanguageOnce\(/);
  assert.match(wrapper, /generate: \(prompt\) => generateSummaryceptionCandidate\(\{ \.\.\.args, prompt, singleAttempt: true \}\)/);
  assert.match(source, /singleAttempt: args\.singleAttempt/);
  assert.match(source, /fallbackModels: args\.singleAttempt \|\|/);
  const calls = [...source.matchAll(/await generateSummaryceptionText\(\{([\s\S]*?)prompt:/g)];
  assert.equal(calls.length, 2, "both layer zero and promotion must use the checked wrapper");
  for (const call of calls) assert.match(call[1]!, /language[,:]/);
});
