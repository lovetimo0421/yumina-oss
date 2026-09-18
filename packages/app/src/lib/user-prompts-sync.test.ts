import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── Custom prompts: cross-device sync pins (2026-09-01) ────────────────────
// Community report: editing a custom prompt on one device left other devices
// on the old copy — and sometimes the stale device SAVED the old copy back
// over the new one. Two legs, each pinned here so neither is refactored away
// alone:
//   1. The store must always revalidate (the old `if (get().fetched) return`
//      meant one fetch per SPA lifetime, and mobile browsers park SPA tabs
//      for days).
//   2. Content edits must carry `expectedUpdatedAt` so the server can refuse
//      a stale save with a 409 instead of clobbering the newer edit.

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => readFileSync(join(here, rel), "utf8").replace(/\r\n/g, "\n");
const storeSrc = readSrc("../stores/user-prompts.ts");
const componentSrc = readSrc("../features/configs/global-prompts.tsx");

test("fetchPrompts always revalidates — no fetch-once cache", () => {
  assert.ok(
    !storeSrc.includes("if (get().fetched) return"),
    "the fetch-once early return must not come back — it froze other devices' edits out of long-lived tabs",
  );
  assert.match(storeSrc, /cache:\s*"no-store"/, "the list fetch must bypass HTTP caches");
});

test("content edits carry expectedUpdatedAt and handle the 409 conflict", () => {
  assert.match(storeSrc, /expectedUpdatedAt/, "updatePrompt must send the loaded updatedAt for content edits");
  assert.match(
    storeSrc,
    /"name" in data \|\| "content" in data/,
    "the guard applies to content-bearing edits only (a fast enabled-toggle pair must not race itself into a false conflict)",
  );
  assert.match(storeSrc, /res\.status === 409/, "a stale save must be refused, not clobber the newer edit");
  // The copy moved from `toasts:promptEditConflict` to the profile namespace when
  // the sweep replaced toasts with the feedback pill; the invariant is unchanged —
  // the refusal must still say something localized.
  assert.match(
    storeSrc,
    /customPrompts\.editConflict/,
    "the refusal must tell the user what happened, localized",
  );
});

test("the prompts panel revalidates when the tab becomes visible again", () => {
  assert.match(componentSrc, /visibilitychange/, "long-parked mobile tabs must refetch on return");
});
