import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveMute, isMuteActive } from "./mute-policy.js";

const at = (ms: number) => new Date(Date.now() + ms);

test("a mute in either store binds everywhere, and the longer one wins", () => {
  const soon = at(60_000);
  const later = at(10 * 60_000);

  // Neither store: not muted.
  assert.equal(effectiveMute({ isMuted: false, mutedUntil: null }, null), null);

  // Only the account store — what the account moderation screen writes.
  assert.deepEqual(effectiveMute({ isMuted: true, mutedUntil: soon }, null), { mutedUntil: soon });

  // Only the community store — what the community moderation screen writes.
  // This is the case that used to leave DMs, event submissions and update
  // notes open: the account gate never looked here.
  assert.deepEqual(
    effectiveMute({ isMuted: false, mutedUntil: null }, { expiresAt: soon, revokedAt: null }),
    { mutedUntil: soon },
  );

  // Both: the one that lasts longer is the one that binds, whichever store it
  // came from.
  assert.deepEqual(effectiveMute({ isMuted: true, mutedUntil: soon }, { expiresAt: later, revokedAt: null }), { mutedUntil: later });
  assert.deepEqual(effectiveMute({ isMuted: true, mutedUntil: later }, { expiresAt: soon, revokedAt: null }), { mutedUntil: later });

  // A permanent account mute has no expiry, and no dated community row can
  // shorten it. Only the account store can express this.
  assert.deepEqual(effectiveMute({ isMuted: true, mutedUntil: null }, { expiresAt: soon, revokedAt: null }), { mutedUntil: null });
  assert.deepEqual(effectiveMute({ isMuted: true, mutedUntil: null }, null), { mutedUntil: null });
});

test("expired and revoked mutes stop binding", () => {
  const past = at(-60_000);
  const soon = at(60_000);

  assert.equal(effectiveMute({ isMuted: true, mutedUntil: past }, null), null);
  assert.equal(effectiveMute({ isMuted: false, mutedUntil: null }, { expiresAt: past, revokedAt: null }), null);
  assert.equal(effectiveMute({ isMuted: false, mutedUntil: null }, { expiresAt: soon, revokedAt: at(-1) }), null);
  assert.equal(isMuteActive({ expiresAt: soon, revokedAt: at(-1) }), false);

  // An expired half must not mask an active one.
  assert.deepEqual(effectiveMute({ isMuted: true, mutedUntil: past }, { expiresAt: soon, revokedAt: null }), { mutedUntil: soon });
  assert.deepEqual(effectiveMute({ isMuted: true, mutedUntil: soon }, { expiresAt: past, revokedAt: null }), { mutedUntil: soon });
});

test("an absent account record is not a mute", () => {
  assert.equal(effectiveMute(null, null), null);
  assert.equal(effectiveMute(undefined, undefined), null);
  assert.deepEqual(effectiveMute(null, { expiresAt: at(60_000), revokedAt: null })?.mutedUntil instanceof Date, true);
});
