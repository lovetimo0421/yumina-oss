import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { drawCandy, halloweenActive, halloweenWindow } from "./halloween.js";

describe("halloween candy", () => {
  it("every draw stays inside 30–200 in steps of 5, tricks doubled", () => {
    let seed = 7;
    const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    let tricks = 0;
    for (let i = 0; i < 20_000; i++) {
      const { amount, trick } = drawCandy(random);
      assert.ok(amount >= 30 && amount <= 200, `amount ${amount}`);
      assert.equal(amount % 5, 0);
      if (trick) { tricks++; assert.equal(amount % 10, 0); assert.ok(amount >= 60); }
    }
    assert.ok(tricks > 3_000 && tricks < 5_000, `tricks ${tricks}`);
  });

  it("the extremes are reachable", () => {
    assert.deepEqual(drawCandy(() => 0.5), { amount: 30 + 5 * Math.floor(0.5 * 35), trick: false });
    assert.deepEqual(drawCandy(() => 0), { amount: 60, trick: true });
    const top = [0.5, 0.999999];
    assert.deepEqual(drawCandy(() => top.shift()!), { amount: 200, trick: false });
  });
});

describe("halloween window", () => {
  beforeEach(() => { delete process.env.HALLOWEEN_STARTS_AT; delete process.env.HALLOWEEN_ENDS_AT; });

  it("runs Oct 31 04:00 to Nov 3 04:00 Asia/Shanghai by default", () => {
    const { startsAt, endsAt } = halloweenWindow();
    assert.equal(startsAt.toISOString(), "2026-10-30T20:00:00.000Z");
    assert.equal(endsAt.toISOString(), "2026-11-02T20:00:00.000Z");
    assert.equal(halloweenActive(new Date("2026-10-30T19:59:59Z")), false);
    assert.equal(halloweenActive(new Date("2026-10-31T23:00:00Z")), true);
    assert.equal(halloweenActive(new Date("2026-11-02T20:00:00Z")), false);
  });

  it("env overrides move it for testing; garbage falls back", () => {
    process.env.HALLOWEEN_STARTS_AT = "2026-10-01T00:00:00Z";
    process.env.HALLOWEEN_ENDS_AT = "not a date";
    const { startsAt, endsAt } = halloweenWindow();
    assert.equal(startsAt.toISOString(), "2026-10-01T00:00:00.000Z");
    assert.equal(endsAt.toISOString(), "2026-11-02T20:00:00.000Z");
  });
});
