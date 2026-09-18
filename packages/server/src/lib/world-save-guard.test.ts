import test from "node:test";
import assert from "node:assert/strict";
import { isStaleDraftSave } from "./world-save-guard.js";

const T0 = new Date("2026-06-01T10:00:00.000Z");
const T1 = new Date("2026-06-01T10:05:00.000Z");

test("draft: live row moved since the editor loaded → stale (reject)", () => {
  // Editor synced at T0; the Studio agent wrote and bumped updatedAt to T1.
  assert.equal(
    isStaleDraftSave({
      clientBaseUpdatedAt: T0.toISOString(),
      liveStatus: "draft",
      liveUpdatedAt: T1,
    }),
    true,
  );
});

test("draft: token matches live updatedAt → not stale (allow)", () => {
  assert.equal(
    isStaleDraftSave({
      clientBaseUpdatedAt: T0.toISOString(),
      liveStatus: "draft",
      liveUpdatedAt: T0,
    }),
    false,
  );
});

test("draft: token matches even with sub-second precision (same Date) → allow", () => {
  // The GET serializes the Date to ISO and the PATCH compares
  // liveUpdatedAt.toISOString() — both derive from the same Date, so a
  // millisecond-precise timestamp must still match.
  const t = new Date("2026-06-01T10:00:00.123Z");
  assert.equal(
    isStaleDraftSave({
      clientBaseUpdatedAt: t.toISOString(),
      liveStatus: "draft",
      liveUpdatedAt: t,
    }),
    false,
  );
});

test("no token sent → guard off (back-compat: old clients, imports, new worlds)", () => {
  assert.equal(
    isStaleDraftSave({
      clientBaseUpdatedAt: null,
      liveStatus: "draft",
      liveUpdatedAt: T1,
    }),
    false,
  );
});

test("published world → guard off even if it moved (held-edit path owns concurrency)", () => {
  assert.equal(
    isStaleDraftSave({
      clientBaseUpdatedAt: T0.toISOString(),
      liveStatus: "published",
      liveUpdatedAt: T1,
    }),
    false,
  );
});

test("no live row / no timestamp → not stale (route's 404 handling takes over)", () => {
  assert.equal(
    isStaleDraftSave({
      clientBaseUpdatedAt: T0.toISOString(),
      liveStatus: undefined,
      liveUpdatedAt: undefined,
    }),
    false,
  );
  assert.equal(
    isStaleDraftSave({
      clientBaseUpdatedAt: T0.toISOString(),
      liveStatus: "draft",
      liveUpdatedAt: null,
    }),
    false,
  );
});

test("unpublished (non-published, non-draft) world is also guarded", () => {
  // Anything that isn't "published" routes through the direct worlds.schema
  // write, so the guard applies — only "published" defers to the held-edit path.
  assert.equal(
    isStaleDraftSave({
      clientBaseUpdatedAt: T0.toISOString(),
      liveStatus: "unpublished",
      liveUpdatedAt: T1,
    }),
    true,
  );
});
