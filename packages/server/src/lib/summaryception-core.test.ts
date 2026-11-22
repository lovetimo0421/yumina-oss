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
  assert.match(wrapper, /await correctSummaryLanguageOnce\(/);
  assert.match(wrapper, /await generateSummaryceptionCandidate\(\{ \.\.\.args, model, prompt, singleAttempt: true \}\)/, "the correction runs on the model that wrote the snippet");
  // The player's own API is always one attempt; otherwise the caller decides.
  assert.match(source, /singleAttempt: ownModel \|\| args\.singleAttempt/);
  assert.match(source, /fallbackModels: args\.singleAttempt \|\|/);
  const calls = [...source.matchAll(/await generateSummaryceptionText\(\{([\s\S]*?)prompt:/g)];
  assert.equal(calls.length, 5, "layer zero, set-aside fills, merges and both kinds of revision must use the checked wrapper");
  for (const call of calls) assert.match(call[1]!, /language[,:]/);
});

test("recap context keeps the chapters before the passage and the opening, not the middle", async () => {
  const { assembleRecapContext } = await loadModule();
  const snippets = Array.from({ length: 10 }, (_, i) => ({ layerIndex: 0, snippetOrder: i, text: `c${i}` }));
  const words = (text: string) => (text === "…" ? 0 : 100);
  assert.equal(assembleRecapContext(snippets, words, 300, 200), "c0 c1 … c7 c8 c9");
  // Small enough: everything, in story order.
  assert.equal(assembleRecapContext(snippets.slice(0, 4), words, 300, 200), "c0 c1 c2 c3");
  // Higher layers are older story.
  assert.equal(
    assembleRecapContext([{ layerIndex: 0, snippetOrder: 0, text: "new" }, { layerIndex: 2, snippetOrder: 0, text: "old" }], words, 300, 200),
    "old new",
  );
});

test("recap context takes the newest part of one chapter longer than the window", async () => {
  const { assembleRecapContext } = await loadModule();
  const long = "a".repeat(1000) + "END";
  const text = assembleRecapContext([{ layerIndex: 4, snippetOrder: 0, text: long }], (t) => t.length, 100, 50);
  assert.ok(text.endsWith("END"));
  assert.ok(text.length <= 110);
});

test("a cut-off chapter ends at its last full sentence", async () => {
  const { endAtLastSentence } = await loadModule();
  assert.equal(endAtLastSentence("林走进城门；守卫认出了他。他掏出令牌，守卫"), "林走进城门；守卫认出了他。");
  assert.equal(endAtLastSentence("Lin enters the gate; the guard knows him. He shows the tok"), "Lin enters the gate; the guard knows him.");
  // Nothing to cut back to without losing most of it.
  assert.equal(endAtLastSentence("short. then a very long unfinished clause that goes on and on and on"), "short. then a very long unfinished clause that goes on and on and on");
});
