import { eq, sql } from 'drizzle-orm';
import { getAgeFromBirthYear } from '@yumina/shared';
import { db, type DrizzleDB } from '../db/index.js';
import { user } from '../db/schema.js';

/**
 * 解除限制 age gate. This is the ONLY special handling left for 解除限制 content:
 * kind='unrestrict' prompts (installed presets or the player's own) are never sent
 * for safe-mode / minor accounts. Everything else about them is an ordinary,
 * editable, toggleable, per-model-bindable prompt.
 */

/** user_prompts.kind for 解除限制-type prompts (installed presets and the player's own). */
export const UNRESTRICT_KIND = 'unrestrict';

const ADULT_CONTENT_LEVELS = new Set(['sensitive', 'r18', 'r18g']);

export type UnrestrictIneligibleReason = 'safe-mode' | 'minor' | 'no-birth-year';
export interface UnrestrictEligibility {
  eligible: boolean;
  reason: UnrestrictIneligibleReason | null;
}

/**
 * Pure rule. ELIGIBLE = contentLevel in (sensitive|r18|r18g) AND birthYear known AND age >= 18.
 * A known minor is always 'minor' (strongest reason). 'no-birth-year' is only reported to an
 * account already in an adult content level — it is the one reason the UI can resolve itself.
 */
export function evaluateUnrestrictEligibility(
  row: { contentLevel: unknown; birthYear: number | null | undefined } | null | undefined,
): UnrestrictEligibility {
  if (!row) return { eligible: false, reason: 'safe-mode' };
  if (row.birthYear != null && getAgeFromBirthYear(row.birthYear) < 18) return { eligible: false, reason: 'minor' };
  if (typeof row.contentLevel !== 'string' || !ADULT_CONTENT_LEVELS.has(row.contentLevel)) {
    return { eligible: false, reason: 'safe-mode' };
  }
  if (row.birthYear == null) return { eligible: false, reason: 'no-birth-year' };
  return { eligible: true, reason: null };
}

/**
 * Reads the user's gating fields. Runs every turn (via loadUserPrompts), so it
 * reads only the JSON key it needs, not the whole preferences blob.
 */
export async function getUnrestrictEligibility(userId: string, database: DrizzleDB = db): Promise<UnrestrictEligibility> {
  const [row] = await database
    .select({
      contentLevel: sql<string | null>`${user.preferences}->>'contentLevel'`,
      birthYear: user.birthYear,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return evaluateUnrestrictEligibility(row ?? null);
}
