/** Single source of truth for how active-persona vs logged-in-account data
 *  gets written into a session's GameState.metadata. Every message/session
 *  endpoint calls this so the resolution rule stays consistent.
 *
 *  Resolution chain (persona > account username > creator default > "Player"):
 *    - persona active  → persona.name + persona.avatarUrl + persona.*
 *    - no persona      → account.username (stable @handle) + account.image
 *
 *  Why username over account.name: `name` is a user-editable display field that
 *  can change or collide. `username` is the unique, stable identifier the user
 *  picked when signing up — it's what creators effectively mean by "who the
 *  player is" when they write {{user}} in a greeting or sandbox component.
 *
 *  The engine's {{user}} macro + sandbox `user` API both read these keys
 *  exclusively — they don't touch `currentUser` directly — so branching
 *  persona vs account happens here in ONE place instead of being duplicated
 *  across every render path. Previous bugs happened because one call site
 *  populated personaName but not the rest, then another site populated
 *  different subsets, producing inconsistent states across session creation
 *  vs message send vs regenerate. */

import type { GameStateManager } from "@yumina/engine";

export interface ActivePersonaLike {
  name: string;
  avatarUrl?: string | null;
  appearance?: string | null;
  personality?: string | null;
  backstory?: string | null;
}

export interface AccountLike {
  /** The user's stable @handle — preferred identity for {{user}} fallback. */
  username?: string | null;
  /** Formatted variant of username (case-preserved). Used if username itself is null. */
  displayUsername?: string | null;
  /** User-editable display name — last resort before literal fallbacks. */
  name?: string | null;
  image?: string | null;
}

/** Write the full persona metadata block. `persona` null = no active persona,
 *  in which case we fall back to the account's stable username so the
 *  {{user}} macro still resolves to something meaningful and unique. */
export function applyPersonaMetadata(
  stateManager: Pick<GameStateManager, "setMetadata">,
  persona: ActivePersonaLike | null | undefined,
  account: AccountLike,
): void {
  if (persona) {
    stateManager.setMetadata("personaActive", true);
    stateManager.setMetadata("personaName", persona.name);
    stateManager.setMetadata("personaImage", persona.avatarUrl ?? "");
    stateManager.setMetadata("personaAppearance", persona.appearance ?? "");
    stateManager.setMetadata("personaPersonality", persona.personality ?? "");
    stateManager.setMetadata("personaBackstory", persona.backstory ?? "");
    return;
  }

  // No active persona — fall back to the account's stable identity.
  // Prefer username (@handle) > displayUsername > name > (nothing — engine
  // then falls through to world.settings.playerName, then "Player").
  const fallbackName =
    account.username
    || account.displayUsername
    || account.name
    || null;
  stateManager.setMetadata("personaActive", false);
  stateManager.setMetadata("personaName", fallbackName ?? undefined);
  stateManager.setMetadata("personaImage", account.image ?? undefined);
  // Explicitly clear persisted fields from a formerly active persona. Persona
  // macros also gate on personaActive, so disabling personas cannot leak stale
  // details into later prompts while {{user}} still resolves to the account.
  stateManager.setMetadata("personaAppearance", "");
  stateManager.setMetadata("personaPersonality", "");
  stateManager.setMetadata("personaBackstory", "");
}

/** Overlay only identity fields, leaving all gameplay state intact. */
export function applyPersonaMetadataToState(
  state: { metadata?: Record<string, unknown> },
  persona: ActivePersonaLike | null,
  account: AccountLike,
): void {
  const metadata = state.metadata ??= {};
  applyPersonaMetadata({ setMetadata: (key, value) => { metadata[key] = value; } }, persona, account);
}
