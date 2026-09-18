import assert from "node:assert/strict";
import test from "node:test";
import { isForkOrphaned, type ForkOrphanInput } from "./fork-orphan.js";

const OTHER = "creator-a";
const ME = "creator-b";
const STAMP = new Date("2026-05-12T00:00:00Z");

/** Defaults describe a plain never-published draft owned by someone else. */
function source(over: Partial<ForkOrphanInput> = {}): ForkOrphanInput {
  return {
    sourceWorldId: "src",
    sourceStatus: "draft",
    sourceIsPublished: false,
    sourcePublishedAt: null,
    sourceCreatorId: OTHER,
    worldCreatorId: ME,
    ...over,
  };
}

// ── The bug ────────────────────────────────────────────────────────────
// Someone shares a world in a DM, you press "Add to my projects", and the copy
// lands in My Projects already struck through and labelled "No longer
// available" — unopenable, and 403 on every message call. The share was a
// DRAFT, which is what the DM world-share card is for ("未发布 — 加入你的作品后
// 才能打开"). Nothing was ever pulled, because nothing was ever live.

test("a copy of a DM-shared draft is not orphaned", () => {
  assert.equal(isForkOrphaned(source()), false);
});

test("a self-duplicate of your own draft is not orphaned", () => {
  assert.equal(isForkOrphaned(source({ sourceCreatorId: ME })), false);
});

// Never-live review states are not takedowns either — a card sitting in review
// or freshly rejected was never on the hub for anyone to lose.
for (const status of ["pending_review", "rejected"]) {
  test(`an unstamped source at '${status}' does not orphan`, () => {
    assert.equal(isForkOrphaned(source({ sourceStatus: status })), false);
  });
}

// ── What tombstoning is actually for ───────────────────────────────────
// These all held before the fix and must keep holding: the creator put a card
// on the hub, people forked it, then the creator took it back down.

test("a copy goes dark once the source is pulled", () => {
  assert.equal(
    isForkOrphaned(source({ sourceStatus: "unpublished", sourcePublishedAt: STAMP })),
    true,
  );
});

// 7 prod cards were pulled before the published_at backfill ran, so they carry
// status='unpublished' with no stamp at all. Status alone has to cover them.
test("a pre-backfill takedown with no published_at stamp still orphans", () => {
  assert.equal(isForkOrphaned(source({ sourceStatus: "unpublished" })), true);
});

// A creator who pulls a card and then moves it back to draft to rework it has
// still pulled it. Status reads 'draft' here, so only the stamp catches it —
// 6 prod copies sit in exactly this state and were dark before the fix.
test("pulled-then-reverted-to-draft keeps forks dark via the stamp", () => {
  assert.equal(isForkOrphaned(source({ sourcePublishedAt: STAMP })), true);
});

test("a live source never orphans its forks", () => {
  assert.equal(
    isForkOrphaned(source({ sourceStatus: "published", sourceIsPublished: true, sourcePublishedAt: STAMP })),
    false,
  );
});

// Pulled, reworked, and put back on the hub — the forks come back with it.
test("a republished source revives its forks", () => {
  assert.equal(
    isForkOrphaned(source({ sourceStatus: "published", sourceIsPublished: true, sourcePublishedAt: STAMP })),
    false,
  );
});

// ── Your own lineage stays yours ───────────────────────────────────────

test("unpublishing your own original does not orphan your own variant", () => {
  assert.equal(
    isForkOrphaned(source({
      sourceStatus: "unpublished",
      sourcePublishedAt: STAMP,
      sourceCreatorId: ME,
    })),
    false,
  );
});

// ── Degenerate shapes ──────────────────────────────────────────────────

test("a world that is not a fork is never orphaned", () => {
  assert.equal(
    isForkOrphaned(source({ sourceWorldId: null, sourceStatus: null })),
    false,
  );
});

// A deleted source row leaves the LEFT JOIN null. The copy holds its own schema
// and stays fully usable, so there is nothing to tombstone.
test("a deleted source row does not orphan the copy", () => {
  assert.equal(
    isForkOrphaned(source({
      sourceStatus: null,
      sourceIsPublished: null,
      sourceCreatorId: null,
    })),
    false,
  );
});
