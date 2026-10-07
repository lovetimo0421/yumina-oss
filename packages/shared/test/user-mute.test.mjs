import { test } from "node:test";
import assert from "node:assert/strict";
import { isUserMuted, muteExpiresAt, muteDurationSchema } from "../dist/index.js";

test("mute durations use exact elapsed days across DST and month boundaries", () => {
  const now = new Date("2026-10-31T23:30:00Z");
  for (const [duration, days] of [["day", 1], ["week", 7], ["month", 30]]) {
    assert.equal(muteExpiresAt(duration, now).getTime() - now.getTime(), days * 86_400_000);
  }
  assert.equal(muteExpiresAt("permanent", now), null);
  assert.equal(now.toISOString(), "2026-10-31T23:30:00.000Z");
});

test("mute expires at the exact boundary and permanent mute needs its flag", () => {
  const until = "2026-09-07T12:00:00.000Z";
  const boundary = Date.parse(until);
  assert.equal(isUserMuted({ isMuted: true, mutedUntil: until }, boundary - 1), true);
  assert.equal(isUserMuted({ isMuted: true, mutedUntil: new Date(until) }, boundary), false);
  assert.equal(isUserMuted({ isMuted: true, mutedUntil: until }, boundary + 1), false);
  assert.equal(isUserMuted({ isMuted: true, mutedUntil: null }), true);
  assert.equal(isUserMuted({ isMuted: false, mutedUntil: null }), false);
  assert.equal(isUserMuted({ isMuted: false, mutedUntil: until }, boundary - 1), false);
  assert.equal(isUserMuted({}), false);
});

test("only supported durations are accepted", () => {
  for (const invalid of [undefined, null, 0, -1, "forever", "", {}, ["day"]]) {
    assert.equal(muteDurationSchema.safeParse(invalid).success, false);
  }
});
