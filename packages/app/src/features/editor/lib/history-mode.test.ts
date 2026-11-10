import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_LATEST, DEFAULT_SUMMARY_LATEST, historyModeSettings, historyWindowOf } from "./history-mode";

test("every choice writes both halves, so 全部 never leaves a summary running", () => {
  const summary = { historyLimit: 30, storySummary: { enabled: true, focus: "who owes whom" } };
  assert.deepEqual(historyModeSettings(summary, "all"), { historyLimit: undefined, storySummary: undefined });
  assert.deepEqual(historyWindowOf({ ...summary, ...historyModeSettings(summary, "all") }), { mode: "all", count: undefined });
  assert.deepEqual(historyModeSettings(summary, "latest"), { historyLimit: 30, storySummary: undefined });
  // Back to the summary from a plain window: the window is kept.
  assert.deepEqual(historyModeSettings({ historyLimit: 12 }, "summary"), { historyLimit: 12, storySummary: { enabled: true } });
  assert.deepEqual(historyModeSettings(undefined, "latest"), { historyLimit: DEFAULT_LATEST, storySummary: undefined });
  assert.deepEqual(historyModeSettings(undefined, "summary"), { historyLimit: DEFAULT_SUMMARY_LATEST, storySummary: { enabled: true } });
});

test("a summary left on without a window reads as a summary over the whole budget, never a window of 0", () => {
  // What the card form used to leave behind when 全部 was picked there.
  assert.deepEqual(historyWindowOf({ storySummary: { enabled: true } }), { mode: "summary", count: undefined });
  assert.deepEqual(historyWindowOf({ historyLimit: 0 }), { mode: "all", count: undefined });
  assert.deepEqual(historyWindowOf({ historyLimit: 900 }), { mode: "latest", count: 500 });
  assert.deepEqual(historyModeSettings({ storySummary: { enabled: true } }, "summary").historyLimit, DEFAULT_SUMMARY_LATEST);
});
