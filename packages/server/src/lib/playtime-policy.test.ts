import test from "node:test";
import assert from "node:assert/strict";
import { playtimeDecision } from "./playtime-policy.js";
test("lease ownership, repeated heartbeat, stale requests and suspended tabs", () => {
  const at = new Date("2026-04-01T23:59:55Z"),
    next = new Date(+at + 15000);
  const lease = { leaseId: "a", seenAt: at, syncedAt: at };
  assert.equal(playtimeDecision(lease, "tick", "b", next).accepted, false);
  assert.equal(playtimeDecision(lease, "resume", "b", next).accepted, false);
  assert.equal(playtimeDecision(lease, "tick", "a", next).deltaSeconds, 15);
  assert.equal(
    playtimeDecision(
      { ...lease, seenAt: next, syncedAt: next },
      "tick",
      "a",
      next,
    ).deltaSeconds,
    0,
  );
  assert.equal(
    playtimeDecision(
      { ...lease, seenAt: next, syncedAt: next },
      "tick",
      "a",
      at,
    ).accepted,
    false,
  );
  assert.equal(
    playtimeDecision(lease, "tick", "a", new Date(+at + 91_000)).deltaSeconds,
    0,
  );
  assert.equal(
    playtimeDecision(lease, "resume", "b", new Date(+at + 46_000)).accepted,
    true,
  );
});

test("reacquiring the same lease after a failed tick preserves elapsed playtime", () => {
  const at = new Date("2026-09-16T00:00:00Z");
  const lease = { leaseId: "a", seenAt: at, syncedAt: at };
  assert.equal(playtimeDecision(lease, "resume", "a", new Date(+at + 20_000), true).deltaSeconds, 20);
  assert.equal(playtimeDecision(lease, "resume", "b", new Date(+at + 46_000)).deltaSeconds, 0);
  assert.equal(playtimeDecision(lease, "resume", "a", new Date(+at + 91_000)).deltaSeconds, 0);
});

test("resuming after suspension cannot credit hidden time when pause was lost", () => {
  const at = new Date("2026-09-16T00:00:00Z");
  const lease = { leaseId: "a", seenAt: at, syncedAt: at };
  const resume = playtimeDecision(lease, "resume", "a", new Date(+at + 65_000));
  assert.equal(resume.accepted, true);
  assert.equal(resume.deltaSeconds, 0);
  assert.equal(resume.syncedAt?.getTime(), +at + 65_000);
});

test("pause reports the awarded boundary even though the route releases its lease", () => {
  const at = new Date("2026-09-16T00:00:00Z");
  const pause = playtimeDecision({leaseId:"a",seenAt:new Date(+at+15_900),syncedAt:new Date(+at+15_000)},"pause","a",new Date(+at+16_500));
  assert.equal(pause.active,false);
  assert.equal(pause.deltaSeconds,1);
  assert.equal(pause.syncedAt?.getTime(),+at+16_000);
});

test("heartbeat rounding carries fractional seconds into the next tick", () => {
  const at = new Date("2026-09-16T00:00:00Z");
  const first = playtimeDecision({ leaseId: "a", seenAt: at, syncedAt: at }, "tick", "a", new Date(+at + 15_900));
  assert.equal(first.deltaSeconds, 15);
  assert.equal(first.syncedAt?.getTime(), +at + 15_000);
  const second = playtimeDecision({ leaseId: "a", seenAt: new Date(+at + 15_900), syncedAt: first.syncedAt! }, "tick", "a", new Date(+at + 31_800));
  assert.equal(second.deltaSeconds, 16);
  assert.equal(second.syncedAt?.getTime(), +at + 31_000);
});
