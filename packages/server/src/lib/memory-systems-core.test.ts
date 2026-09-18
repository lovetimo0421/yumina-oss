import test from "node:test";
import assert from "node:assert/strict";

async function loadModule() {
  return import("./memory-systems-core.js");
}

test("memory system settings default to Session Memory plus LocalDev Summary", async () => {
  const { getMemorySystemSettings } = await loadModule();
  assert.deepEqual(getMemorySystemSettings({}), {
    sessionMemoryIncluded: true,
    localdevSummaryIncluded: true,
    summaryceptionIncluded: false,
  });
});

test("legacy Summaryception sessions remain Summaryception-only when the new flag is absent", async () => {
  const { getMemorySystemSettings } = await loadModule();
  assert.deepEqual(getMemorySystemSettings({ summaryImplementation: "summaryception" }), {
    sessionMemoryIncluded: true,
    localdevSummaryIncluded: false,
    summaryceptionIncluded: true,
  });
});

test("raw history filtering follows the enabled summary systems", async () => {
  const { shouldUseRawHistoryMessage } = await loadModule();
  const localdevCompacted = { compacted: true, summaryceptionCompacted: false };
  const summaryceptionCompacted = { compacted: false, summaryceptionCompacted: true };
  const bothCompacted = { compacted: true, summaryceptionCompacted: true };

  assert.equal(shouldUseRawHistoryMessage({ localdevSummaryIncluded: false, summaryceptionIncluded: false }, bothCompacted), true);
  assert.equal(shouldUseRawHistoryMessage({ localdevSummaryIncluded: true, summaryceptionIncluded: false }, localdevCompacted), false);
  assert.equal(shouldUseRawHistoryMessage({ localdevSummaryIncluded: false, summaryceptionIncluded: true }, summaryceptionCompacted), false);
  assert.equal(shouldUseRawHistoryMessage({ localdevSummaryIncluded: true, summaryceptionIncluded: true }, localdevCompacted), false);
  assert.equal(shouldUseRawHistoryMessage({ localdevSummaryIncluded: true, summaryceptionIncluded: true }, summaryceptionCompacted), false);
  assert.equal(shouldUseRawHistoryMessage({ localdevSummaryIncluded: true, summaryceptionIncluded: true }, { compacted: false, summaryceptionCompacted: false }), true);
});

