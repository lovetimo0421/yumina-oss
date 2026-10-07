import {
  getMemorySystemSettings,
  type MemorySystemSettings,
  type SessionMemorySystemRow,
} from "./memory-systems-core.js";
import { isExtensionInstalled } from "./extensions.js";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import { and, eq, sql } from "drizzle-orm";
import { readOwn } from "../db/index.js";
import { playSessions, worlds } from "../db/schema.js";

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

/** What a card that switched the summary on gets for a player without the
 *  extension: the story summary alone. */
const AUTHOR_SUMMARY_ONLY: MemorySystemSettings = {
  sessionMemoryIncluded: false,
  localdevSummaryIncluded: true,
  summaryceptionIncluded: false,
};

/**
 * Whether this session's card switched the story summary on for everyone
 * (Context → 摘要 + 最新 N 条, `settings.storySummary.enabled`). Read from the
 * primary like every entitlement check. False when the session is not the
 * user's or does not exist.
 */
export async function sessionWorldRequiresStorySummary(sessionId: string, userId: string): Promise<boolean> {
  const rd = await readOwn(userId);
  const [row] = await rd
    .select({
      required: sql<boolean>`coalesce((${worlds.schema} -> 'settings' -> 'storySummary' ->> 'enabled')::boolean, false)`,
    })
    .from(playSessions)
    .innerJoin(worlds, eq(playSessions.worldId, worlds.id))
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)))
    .limit(1);
  return row?.required === true;
}

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
  opts: { authorRequired?: boolean } = {},
): Promise<MemorySystemSettings> {
  if (!(await isExtensionInstalled(userId, SESSION_MEMORY_EXTENSION_KEY))) {
    return opts.authorRequired ? AUTHOR_SUMMARY_ONLY : ALL_DISABLED;
  }
  return getMemorySystemSettings(row);
}
