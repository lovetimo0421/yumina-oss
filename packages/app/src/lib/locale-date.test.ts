import assert from "node:assert/strict";
import test from "node:test";
import { formatDate, formatDateTime, formatMonthYear, formatRelativeTime, formatShortDateTime } from "./locale-date";

const at = "2026-09-25T21:28:00Z";

test("dates follow the requested locale, not en-US", () => {
  assert.match(formatDate(at, "zh"), /2026年9月2[56]日/);
  assert.match(formatDate(at, "ja"), /2026年9月2[56]日/);
  assert.match(formatDate(at, "en"), /Sep 2[56], 2026/);
  assert.match(formatMonthYear("2026-04-10T00:00:00Z", "zh"), /2026年4月/);
  assert.match(formatMonthYear("2026-04-10T00:00:00Z", "es"), /abr/i);
  assert.doesNotMatch(formatDateTime(at, "zh"), /PM|AM|Sep/);
  assert.doesNotMatch(formatShortDateTime(at, "ja"), /PM|AM|Sep/);
});

test("relative time is localized", () => {
  const minuteAgo = new Date(Date.now() - 61_000).toISOString();
  assert.match(formatRelativeTime(minuteAgo, "zh"), /1\s*分钟前/);
  assert.match(formatRelativeTime(minuteAgo, "en"), /1 minute ago/);
  assert.doesNotMatch(formatRelativeTime(minuteAgo, "ja"), /ago/);
});

test("invalid input and odd locales degrade quietly", () => {
  assert.equal(formatDate("not a date", "zh"), "—");
  assert.equal(formatRelativeTime("nope", "zh"), "—");
  assert.ok(formatDate(at, "zh-Hant").includes("2026"));
});
