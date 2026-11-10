import assert from "node:assert/strict";
import test from "node:test";
import { formatTimeAgo, parseServerTime } from "./format-time";

test("zone-less server timestamps are UTC, never local time", () => {
  const utc = Date.UTC(2026, 8, 25, 8, 12, 3, 123);
  assert.equal(parseServerTime("2026-09-25 08:12:03.123"), utc);
  assert.equal(parseServerTime("2026-09-25T08:12:03.123"), utc);
  assert.equal(parseServerTime("2026-09-25T08:12:03.123Z"), utc);
  assert.equal(parseServerTime("2026-09-25 08:12:03.123+00"), utc);
  assert.equal(parseServerTime("2026-09-25 16:12:03.123+08:00"), utc);
  assert.equal(parseServerTime("2026-09-25 16:12:03.123+0800"), utc);
  assert.equal(parseServerTime(new Date(utc)), utc);
});

test("relative time is localized and never negative", () => {
  const sevenMinutesAgo = new Date(Date.now() - 7 * 60_000).toISOString().replace("T", " ").replace("Z", "");
  assert.equal(formatTimeAgo(sevenMinutesAgo, "zh"), "7分钟前");
  assert.equal(formatTimeAgo(sevenMinutesAgo, "en"), "7 minutes ago");
  // A timestamp slightly in the future (clock skew) reads as now.
  const ahead = new Date(Date.now() + 90_000).toISOString();
  assert.doesNotMatch(formatTimeAgo(ahead, "en"), /in |-/);
});
