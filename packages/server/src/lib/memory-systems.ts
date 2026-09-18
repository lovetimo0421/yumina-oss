import {
  getMemorySystemSettings,
  type MemorySystemSettings,
  type SessionMemorySystemRow,
} from "./memory-systems-core.js";
import { isExtensionInstalled } from "./extensions.js";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";

// Entitlement-aware wrapper over the pure getMemorySystemSettings(). Kept in a
// non-core module so memory-systems-core.ts stays DB-free (its pure unit test is
// untouched). This is the single server gate for the session-memory extension:
// route the 4 settings-read seams through here and every downstream
// `if (settings.*Included)` short-circuits when the extension is uninstalled.

const ALL_DISABLED: MemorySystemSettings = {
  sessionMemoryIncluded: false,
  localdevSummaryIncluded: false,
  summaryceptionIncluded: false,
};

/**
 * Memory settings honoring the "session-memory-summary" extension entitlement.
 * Returns all-false when the extension is not installed for the user (so no
 * prompt injection, no raw-history exclusion of compacted messages, no pre-gen
 * compaction, and no post-response scheduling happen); otherwise defers to the
 * pure mapper. Async because it consults the entitlement gate.
 */
export async function resolveMemorySystemSettings(
  userId: string,
  row: SessionMemorySystemRow,
): Promise<MemorySystemSettings> {
  if (!(await isExtensionInstalled(userId, SESSION_MEMORY_EXTENSION_KEY))) {
    return ALL_DISABLED;
  }
  return getMemorySystemSettings(row);
}
