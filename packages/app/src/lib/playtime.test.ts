import assert from "node:assert/strict";
import test from "node:test";
import { formatPlaytimeShort, formatTimeUnit } from "./playtime";

test("a just-played session shows minutes, not 0.0 h", () => {
  assert.equal(formatPlaytimeShort(20, "en"), "<1 min");
  assert.equal(formatPlaytimeShort(12 * 60 + 5, "en"), "12 min");
  assert.equal(formatPlaytimeShort(90 * 60, "en"), "1.5 hr");
  assert.equal(formatPlaytimeShort(12 * 60, "zh"), "12分钟");
  assert.equal(formatPlaytimeShort(null, "en"), "--");
});

test("a browser whose Intl has no unit data still gets a time, not a crash", () => {
  // Quark's U4 kernel throws RangeError on style: "unit"; that took the whole
  // home page down. Swap the constructor for one that throws the same way.
  const real = Intl.NumberFormat;
  Intl.NumberFormat = function (locale?: string | string[], options?: Intl.NumberFormatOptions) {
    if (options?.style === "unit") throw new RangeError("Value unit out of range for Intl.NumberFormat options property style");
    return new real(locale, options);
  } as unknown as typeof Intl.NumberFormat;
  try {
    assert.equal(formatTimeUnit(2.345, "hour", "zh", "long", 1), "2.3 h");
    assert.equal(formatPlaytimeShort(12 * 60, "en"), "12 min");
  } finally {
    Intl.NumberFormat = real;
  }
});
